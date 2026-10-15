# Oppdateringer til andre PC-er

Sammen har et offentlig GitHub-repo: [k66yvb2gxj-ui/sammen](https://github.com/k66yvb2gxj-ui/sammen). Nye Windows-pakker skal hentes fra [GitHub Releases](https://github.com/k66yvb2gxj-ui/sammen/releases). Arbeidsflyten i `.github/workflows/windows-release.yml` bygger pakkene og oppretter et utkast til utgivelse. Elevene får en fungerende nedlastingslenke når en kontrollert utgivelse er publisert. Ingen personlig GitHub-nøkkel følger appen.

## Det eksisterende ZIP-bygget

ZIP-versjon 0.3.0 som allerede er overført, har ingen automatisk oppdatering. En endring på utviklings-PC-en endrer ikke appen på andre PC-er. Elevene må få en ny pakke og bytte til den. Behold appens lokale data ved oppgradering; ikke slett appdatamappen.

## Oppdateringssjekken i 0.4.0

Fra 0.4.0 sjekker desktop-appen GitHubs offentlige utgivelsesmetadata ved oppstart. En nyere, publisert stabil versjon viser en **Oppdater**-knapp. Under **Profil → Oppdateringer** kan brukeren også sjekke manuelt og velge **Last ned**, som åpner den aktuelle utgivelsens side i nettleseren.

Brukeren laster selv ned og åpner installeren eller pakker ut ZIP-en. Appen laster ikke ned eller kjører en installer i bakgrunnen. Utkast og forhåndsutgivelser tilbys ikke som stabile oppdateringer. Hvis ingen stabil versjon er publisert, viser appen det. Nettverksfeil påvirker ikke tilgangen til lokale notater.

## Pakker fra GitHub Actions

På en versjonstagg som `v0.4.0` skal versjonen i `package.json` være nøyaktig `0.4.0`. Arbeidsflyten avviser tagger som ikke samsvarer.

Den kjører `npm ci`, testene og bygging av samarbeidsmodulen. Det eksisterende `prepare:remote`-skriptet klargjør en separat, låst fjernagent med offisiell Node-runtime og kontroll av Node-arkivets SHA-256. Deretter bygges Windows x64 som:

- en NSIS-installer for den innloggede Windows-brukeren, uten valg om maskininstallasjon;
- en portabel ZIP for manuell utpakking;
- SHA-256-kontrollsummer og eventuelle oppdateringsfiler fra byggeren.

Manuell **Run workflow** bygger pakker uten å opprette en utgivelse. Artifaktene beholdes i 14 dager. Ved tagg opprettes et **utkast** til GitHub Release med pakkene. Et utkast er ikke en offentlig nedlastingslenke. En ansvarlig må kontrollere og publisere det før elevene kan laste ned. Arbeidsflyten bruker GitHubs midlertidige `GITHUB_TOKEN`; byggjobben har bare lesetilgang, og utgivelsesjobben har skrivetilgang til utgivelsen. [GitHub Actions-autentisering](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token), [GitHub CLI-utgivelser](https://cli.github.com/manual/gh_release_create).

## Overgangen til automatiske oppdateringer

For automatisk installasjon på Windows skal appen bruke `electron-updater` med NSIS, en fast utgivelseskanal og publiserte oppdateringsmetadata som `latest.yml`. Brukeren installerer den første NSIS-versjonen én gang. Etterpå kan appen laste ned en oppdatering og tilby omstart når arbeidet er lagret. Dette er ikke aktivert bare ved å legge til byggjobben. [electron-builder 26: Auto Update](https://www.electron.build/v26/docs/features/auto-update/).

Behold `appId`, produktidentitet og Windows-brukerens datamappe gjennom overgangen. Test at notater og importerte filer finnes etter oppgradering fra dagens ZIP. Skolens regler for hvilke programmer som kan kjøres, gjelder også en installer for én bruker. [electron-builder 26: NSIS](https://www.electron.build/v26/docs/nsis/).

Produksjonskanalen skal bruke kodesignerte Windows-programmer og installere. Vi har ikke et konfigurert sertifikat eller en verifisert signeringsjobb nå. Dagens `signAndEditExecutable: false` må erstattes med en kontrollert signeringskonfigurasjon før produksjonsutgivelser. SHA-256 er en kontroll av filinnholdet og erstatter ikke utgiverens signatur. Behold signaturkontroll ved oppdatering. [electron-builder 26: Windows-signering](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/).

## Før en utgivelse publiseres

1. Bygg og test den taggede versjonen i Actions.
2. Last ned utkastets installer på en separat PC og test oppstart, eksisterende notater og en oppgradering.
3. Kontroller signering for produksjonskanalen og at pakken ikke inneholder notater, øktdata, API-nøkler eller en paret fjernagent.
4. Skriv korte utgivelsesnotater og publiser utkastet. Offentlige nedlastinger skal gå til GitHub Release, ikke en midlertidig adresse på en elev-PC.

Hvis kildekoden senere gjøres privat, må distribusjonen fortsatt ha en egen offentlig nedlastingskanal eller en autentisert tjeneste med tilgang per bruker. En felles personlig GitHub-token skal aldri bygges inn i klientene. Repoet har foreløpig `UNLICENSED`; offentlig synlighet innfører ikke en ny åpen kildekode-lisens.
