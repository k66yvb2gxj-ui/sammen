$ErrorActionPreference = 'Stop'
$sammenProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sammenWorkRoot = [IO.Path]::GetFullPath((Join-Path $sammenProjectRoot '..'))
$sammenBundleRoot = Join-Path $sammenWorkRoot 'remote-device-bundle'
$sammenDownloadRoot = Join-Path $sammenWorkRoot 'remote-device-downloads'
$sammenNodeVersion = '22.23.3'
$sammenNodeArchiveName = "node-v$sammenNodeVersion-win-x64.zip"
$sammenNodeArchiveHash = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'
$sammenAgentVersion = '0.3.0'
New-Item -ItemType Directory -Path $sammenDownloadRoot -Force | Out-Null
New-Item -ItemType Directory -Path $sammenBundleRoot -Force | Out-Null
$sammenArchivePath = Join-Path $sammenDownloadRoot $sammenNodeArchiveName
if (!(Test-Path -LiteralPath $sammenArchivePath)) {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$sammenNodeVersion/$sammenNodeArchiveName" -OutFile $sammenArchivePath -UseBasicParsing
}
if ((Get-FileHash -LiteralPath $sammenArchivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sammenNodeArchiveHash) {
    throw 'Node-arkivet samsvarer ikke med den offisielle SHA-256-kontrollen.'
}
$sammenRuntimeRoot = Join-Path $sammenBundleRoot 'runtime'
if (!(Test-Path -LiteralPath (Join-Path $sammenRuntimeRoot 'node.exe'))) {
    $sammenExtractRoot = Join-Path $sammenDownloadRoot ('extract-' + [guid]::NewGuid().ToString())
    Expand-Archive -LiteralPath $sammenArchivePath -DestinationPath $sammenExtractRoot
    $sammenExtractedRuntime = [IO.Path]::GetFullPath((Join-Path $sammenExtractRoot "node-v$sammenNodeVersion-win-x64"))
    if (!$sammenExtractedRuntime.StartsWith($sammenDownloadRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or !$sammenRuntimeRoot.StartsWith($sammenWorkRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Uventet pakkesti.'
    }
    Move-Item -LiteralPath $sammenExtractedRuntime -Destination $sammenRuntimeRoot
}
$sammenNodeExecutable = Join-Path $sammenRuntimeRoot 'node.exe'
if ((& $sammenNodeExecutable --version) -ne "v$sammenNodeVersion") { throw 'Feil Node-versjon i runtime.' }
$sammenAgentRoot = Join-Path $sammenBundleRoot 'agent'
New-Item -ItemType Directory -Path $sammenAgentRoot -Force | Out-Null
$sammenAgentPackage = @{ name = 'sammen-remote-device-bundle'; version = '1.0.0'; private = $true; dependencies = @{ '@wonderwhy-er/desktop-commander' = $sammenAgentVersion }; overrides = @{ 'chokidar' = '4.0.3'; 'argparse' = '2.0.1'; 'uuid' = '11.1.1' } }
$sammenUtf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $sammenAgentRoot 'package.json'), ($sammenAgentPackage | ConvertTo-Json -Depth 4), $sammenUtf8)
$sammenNpmCli = Join-Path $sammenRuntimeRoot 'node_modules\npm\bin\npm-cli.js'
$sammenNpmArguments = @($sammenNpmCli, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
$sammenCheckedLock = Join-Path $PSScriptRoot 'remote-device-package-lock.json'
if (Test-Path -LiteralPath $sammenCheckedLock) {
    Copy-Item -LiteralPath $sammenCheckedLock -Destination (Join-Path $sammenAgentRoot 'package-lock.json') -Force
    $sammenNpmArguments[1] = 'ci'
}
Push-Location -LiteralPath $sammenAgentRoot
try { & $sammenNodeExecutable --use-system-ca @sammenNpmArguments }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'Kunne ikke klargjøre Desktop Commander-pakken.' }
$sammenInstalledPackage = Get-Content -LiteralPath (Join-Path $sammenAgentRoot 'package.json') -Raw | ConvertFrom-Json
if ($sammenInstalledPackage.dependencies.PSObject.Properties.Count -ne 1 -or $sammenInstalledPackage.dependencies.'@wonderwhy-er/desktop-commander' -ne $sammenAgentVersion) { throw 'Uventet avhengighet i fjernagentpakken.' }
$sammenInstalledLock = Get-Content -LiteralPath (Join-Path $sammenAgentRoot 'package-lock.json') -Raw
if ($sammenInstalledLock -match '"link"\s*:\s*true' -or $sammenInstalledLock -match '"resolved"\s*:\s*"file:') { throw 'Lokale prosjektkoblinger kan ikke distribueres i agentpakken.' }
$sammenManifest = @{
    agent = @{ name = '@wonderwhy-er/desktop-commander'; version = $sammenAgentVersion; entry = 'agent/node_modules/@wonderwhy-er/desktop-commander/dist/index.js' }
    runtime = @{ version = $sammenNodeVersion; entry = 'runtime/node.exe'; archiveSha256 = $sammenNodeArchiveHash }
    license = 'MIT'
    sources = @('https://nodejs.org/dist/v22.23.3/SHASUMS256.txt', 'https://registry.npmjs.org/@wonderwhy-er/desktop-commander/0.3.0', 'https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md')
}
[IO.File]::WriteAllText((Join-Path $sammenBundleRoot 'bundle.json'), ($sammenManifest | ConvertTo-Json -Depth 5), $sammenUtf8)
$sammenNotice = @'
# Third-party components

Node.js 22.23.3 is redistributed from the official Windows x64 release. Its complete license and third-party notices are in runtime/LICENSE.

@wonderwhy-er/desktop-commander 0.3.0 is MIT licensed. Its license is in agent/node_modules/@wonderwhy-er/desktop-commander/LICENSE. Dependency license files are retained in their respective node_modules directories. Exact versions and registry integrity hashes are recorded in agent/package-lock.json.

The bundle pins chokidar 4.0.3, argparse 2.0.1 and uuid 11.1.1 to remove advisories in the upstream dependency tree. These dependency overrides are specific to the Sammen bundle; the Desktop Commander agent code is unchanged.

The hosted Remote Desktop Commander service is operated by Desktop Commander. It is not bundled or rebranded. Each device uses the official browser verification flow and the account chosen there. No device sessions, account tokens or credentials are shipped in this bundle.
'@
[IO.File]::WriteAllText((Join-Path $sammenBundleRoot 'THIRD-PARTY-NOTICES.md'), $sammenNotice, $sammenUtf8)
Write-Output "Remote Device-pakke klar: $sammenBundleRoot"
