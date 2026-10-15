param(
  [ValidateSet('doctor','list','read','open')][string]$Mode = 'doctor',
  [ValidateLength(0,500)][string]$Query = '',
  [ValidateLength(0,1000)][string]$QueryBase64 = '',
  [string]$PageID = '',
  [ValidateRange(1,200)][int]$Limit = 60,
  [ValidateRange(0,100000)][int]$Offset = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Output-Json($Value) {
  $Value | ConvertTo-Json -Depth 10 -Compress | Write-Output
}

if ($Mode -eq 'doctor') {
  $registered = $null -ne [Type]::GetTypeFromProgID('OneNote.Application', $false)
  Output-Json ([pscustomobject]@{
    available = $registered; registered = $registered; method = 'OneNote.Application COM'
    checked = 'registration-only'; contentRead = $false; requiresOneNoteDesktop = $true
    message = $(if ($registered) { 'OneNote desktop er registrert. Åpne notatbøkene i OneNote før du henter sidelisten.' } else { 'OneNote desktop er ikke registrert. Installer OneNote for Windows først.' })
  })
  return
}
if ($QueryBase64) {
  try { $Query = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($QueryBase64)) }
  catch { throw 'Ugyldig kodet søk.' }
}
if ($Query.Length -gt 500 -or $Query -match '[\x00-\x1f]') { throw 'Søket inneholder ugyldige kontrolltegn eller er for langt.' }
if (($Mode -eq 'read' -or $Mode -eq 'open') -and ($PageID.StartsWith('-') -or $PageID -notmatch '^[a-zA-Z0-9{}._:-]{1,256}$')) {
  throw 'Velg en gyldig og eksplisitt side-ID fra OneNote-listen.'
}

function Parse-Xml([string]$Text) {
  $settings = New-Object System.Xml.XmlReaderSettings
  $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $stringReader = New-Object System.IO.StringReader($Text)
  $reader = [System.Xml.XmlReader]::Create($stringReader, $settings)
  $document = New-Object System.Xml.XmlDocument
  $document.XmlResolver = $null
  try { $document.Load($reader); return ,$document }
  finally { $reader.Dispose(); $stringReader.Dispose() }
}

function Plain-Text([string]$Value) {
  $text = [regex]::Replace($Value, '(?is)<(script|style|head|iframe)\b[^>]*>.*?(?:</\1\s*>|$)', '')
  $text = [regex]::Replace($text, '(?i)<br\s*/?>', "`n")
  $text = [regex]::Replace($text, '<[^>]*>', ' ')
  $text = [System.Net.WebUtility]::HtmlDecode($text)
  return ([regex]::Replace($text, '[\t \f\v]+', ' ')).Trim()
}

$one = $null
try {
  $one = New-Object -ComObject OneNote.Application
  $raw = ''
  # Enumerate metadata only, using the same local COM methods as the existing reader.
  $one.GetHierarchy('', 4, [ref]$raw, 2)
  $hierarchy = Parse-Xml $raw
  $rows = New-Object 'System.Collections.Generic.List[object]'
  foreach ($node in $hierarchy.SelectNodes('//*[local-name()="Page" and @ID]')) {
    $parts = @(); $ancestor = $node; $deleted = $false; $sectionID = ''
    while ($ancestor -and $ancestor.LocalName -ne 'Notebooks') {
      if ($ancestor.NodeType -ne [Xml.XmlNodeType]::Element) { break }
      $parts = @($ancestor.GetAttribute('name')) + $parts
      if ($ancestor.GetAttribute('isRecycleBin') -eq 'true' -or $ancestor.GetAttribute('isInRecycleBin') -eq 'true' -or $ancestor.GetAttribute('name') -eq 'OneNote_RecycleBin') { $deleted = $true }
      if ($ancestor.LocalName -eq 'Section') { $sectionID = $ancestor.GetAttribute('ID') }
      $ancestor = $ancestor.ParentNode
    }
    if ($deleted) { continue }
    [void]$rows.Add([pscustomobject]@{
      id = $node.GetAttribute('ID'); title = $node.GetAttribute('name'); route = ($parts -join ' > ')
      modified = $node.GetAttribute('lastModifiedTime'); level = $node.GetAttribute('pageLevel'); sectionID = $sectionID
    })
  }
  # Page nesting is encoded as pageLevel order within a section, rather than XML ancestry.
  $stacks = @{}
  foreach ($entry in $rows) {
    if (-not $stacks.ContainsKey($entry.sectionID)) { $stacks[$entry.sectionID] = @{} }
    $stack = $stacks[$entry.sectionID]; $depth = 0
    [void][int]::TryParse($entry.level, [ref]$depth)
    foreach ($key in @($stack.Keys)) { if ([int]$key -ge $depth) { $stack.Remove($key) } }
    $parents = @($stack.Keys | Sort-Object { [int]$_ } | ForEach-Object { $stack[$_] })
    if ($parents.Count) {
      $base = $entry.route.Substring(0, $entry.route.LastIndexOf(' > '))
      $entry.route = $base + ' > ' + (($parents + @($entry.title)) -join ' > ')
    }
    $stack[$depth] = $entry.title
  }
  if ($Mode -eq 'list') {
    $matches = @($rows | Where-Object { -not $Query -or $_.route.IndexOf($Query, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    Output-Json ([pscustomobject]@{
      items = @($matches | Select-Object -Skip $Offset -First $Limit); total = $matches.Count
      offset = $Offset; truncated = (($Offset + $Limit) -lt $matches.Count)
    })
    return
  }
  $selected = @($rows | Where-Object { $_.id -eq $PageID })
  if ($selected.Count -ne 1) { throw 'Side-ID finnes ikke entydig blant åpne OneNote-sider. Hent listen på nytt.' }
  $page = $selected[0]
  if ($Mode -eq 'open') {
    $one.NavigateTo($page.id, '', $false)
    Output-Json ([pscustomobject]@{ id = $page.id; title = $page.title; route = $page.route; opened = $true })
    return
  }
  # Read only this explicit selection. Never loop over page bodies.
  $xml = ''
  $one.GetPageContent($page.id, [ref]$xml, 0, 2)
  $document = Parse-Xml $xml
  $ns = New-Object System.Xml.XmlNamespaceManager($document.NameTable)
  $ns.AddNamespace('o', $document.DocumentElement.NamespaceURI)
  $chunks = New-Object 'System.Collections.Generic.List[string]'
  foreach ($node in $document.SelectNodes('//o:T[not(ancestor::o:Table)] | //o:Table[not(ancestor::o:Table)] | //o:Image', $ns)) {
    if ($node.LocalName -eq 'T') {
      $text = Plain-Text $node.InnerText
      if ($text) { [void]$chunks.Add($text) }
    } elseif ($node.LocalName -eq 'Table') {
      foreach ($row in $node.SelectNodes('o:Row', $ns)) {
        $cells = @($row.SelectNodes('o:Cell', $ns) | ForEach-Object {
          $values = @($_.SelectNodes('.//o:T', $ns) | ForEach-Object { Plain-Text $_.InnerText })
          $values -join ' / '
        })
        [void]$chunks.Add(($cells -join "`t"))
      }
    } else {
      $ocr = @($node.SelectNodes('.//o:OCRText', $ns) | ForEach-Object { Plain-Text $_.InnerText }) -join ' '
      if ($ocr) { [void]$chunks.Add('[OCR fra bilde, kan inneholde feil] ' + $ocr) }
    }
  }
  $warnings = New-Object 'System.Collections.Generic.List[string]'
  [void]$warnings.Add('Dette er en kopi av den valgte siden. Senere endringer i OneNote synkroniseres ikke automatisk.')
  if ($document.SelectNodes('//o:Image', $ns).Count) { [void]$warnings.Add('Bilder er ikke importert. Tilgjengelig OCR-tekst kan følge med, men kan inneholde feil.') }
  if ($document.SelectNodes('//o:InkDrawing | //o:InkWord | //o:Ink', $ns).Count) { [void]$warnings.Add('Håndskrift er ikke importert som pennestreker. Teksten kan derfor være ufullstendig.') }
  if ($document.SelectNodes('//o:InsertedFile', $ns).Count) { [void]$warnings.Add('Vedlegg på OneNote-siden er ikke importert. Legg dokumentene inn separat ved behov.') }
  $content = ($chunks -join "`n`n").Trim()
  if ($content.Length -gt 200000) { $content = $content.Substring(0, 200000); [void]$warnings.Add('Innholdet er avkortet til 200 000 tegn.') }
  if (-not $content) { [void]$warnings.Add('Ingen lesbar tekst ble funnet. Siden kan bestå av bilder eller håndskrift.') }
  $url = ''
  try { $one.GetHyperlinkToObject($page.id, '', [ref]$url) }
  catch { [void]$warnings.Add('OneNote kunne ikke lage en direktelenke til denne siden.') }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $revision = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($xml)))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  Output-Json ([pscustomobject]@{
    id = $page.id; title = $page.title; route = $page.route; modified = $page.modified
    content = $content; sourceUrl = $url; revision = $revision; warnings = @($warnings)
  })
} finally {
  if ($one -and [Runtime.InteropServices.Marshal]::IsComObject($one)) {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($one)
  }
  # Do not call Quit: OneNote remains running and is never terminated by this helper.
}
