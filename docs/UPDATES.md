# Oppdateringer til andre PC-er

Sammen har et offentlig GitHub-repo: [k66yvb2gxj-ui/sammen](https://github.com/k66yvb2gxj-ui/sammen). Nye Windows-pakker skal hentes fra [GitHub Releases](https://github.com/k66yvb2gxj-ui/sammen/releases). Arbeidsflyten i `.github/workflows/windows-release.yml` bygger pakkene og oppretter et utkast til utgivelse. Elevene får en fungerende nedlastingslenke når en kontrollert utgivelse er publisert. Ingen personlig GitHub-nøkkel følger appen.

## Det eksisterende ZIP-bygget

ZIP-versjon 0.3.0 som allerede er overført, har ingen automatisk oppdatering. Brukerne må laste ned og installere 0.4.0 med `.exe` én gang for å komme over på installerens oppdateringskanal. En endring på utviklings-PC-en endrer ikke appen på andre PC-er. Behold appens lokale data ved oppgradering; ikke slett appdatamappen.

## Automatiske oppdateringer fra 0.4.0

Windows-appen som er installert med NSIS, bruker `electron-updater` 6.8.10. Den sjekker GitHubs offentlige, stabile utgivelser og laster ned en nyere pakke automatisk. `electron-updater` kontrollerer SHA-512 mot `latest.yml`. Utkast og forhåndsutgivelser tilbys ikke som stabile oppdateringer. Ingen GitHub-token legges i appen. [electron-builder 26: Auto Update](https://www.electron.build/v26/docs/features/auto-update/).

Når nedlastingen er ferdig, installeres oppdateringen ved normal avslutning. Brukeren kan også velge **Start på nytt og oppdater** under **Profil → Oppdateringer**. Før appen avsluttes, ber hovedprosessen redigeringsvinduet lagre arbeidet, og fjernagenten og samarbeidsforbindelsen stoppes. Oppdatering skal gå gjennom den vanlige avslutningsflyten.

Den portable ZIP-en og sandboxen installerer ikke oppdateringer automatisk. De viser hvorfor automatisk installasjon ikke er tilgjengelig, og bruker oppdateringssjekk eller en lenke til manuell nedlasting. Hvis ingen stabil versjon er publisert, viser appen det. Nettverksfeil påvirker ikke tilgangen til lokale notater.

En full installert oppgradering mellom to publiserte versjoner er ikke verifisert ennå.

## Pakker fra GitHub Actions

På en versjonstagg som `v0.4.0` skal versjonen i `package.json` være nøyaktig `0.4.0`. Arbeidsflyten avviser tagger som ikke samsvarer.

Den kjører `npm ci`, testene og bygging av samarbeidsmodulen. Det eksisterende `prepare:remote`-skriptet klargjør en separat, låst fjernagent med offisiell Node-runtime og kontroll av Node-arkivets SHA-256. Deretter bygges Windows x64 som:

- en NSIS-installer for den innloggede Windows-brukeren, uten valg om maskininstallasjon;
- en portabel ZIP for manuell utpakking;
- `latest.yml`, installerens `.exe.blockmap` og SHA-256-kontrollsummer.

Manuell **Run workflow** bygger pakker uten å opprette en utgivelse. Artifaktene beholdes i 14 dager. Ved tagg opprettes et **utkast** til GitHub Release med pakkene dersom utgivelsen ikke finnes fra før. En eksisterende utgivelse beholder filene og publiseringsstatusen sin. Oppslagsfeil stopper utgivelsesjobben. Et utkast er ikke en offentlig nedlastingslenke; det må kontrolleres og publiseres før elevene får det. Arbeidsflyten bruker GitHubs midlertidige `GITHUB_TOKEN`; byggjobben har bare lesetilgang, og utgivelsesjobben har skrivetilgang til utgivelsen. [GitHub Actions-autentisering](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token), [GitHub CLI-utgivelser](https://cli.github.com/manual/gh_release_create).

## Data og signering

Behold `appId`, produktidentitet og Windows-brukerens datamappe. Test at notater og importerte filer finnes etter oppgradering fra dagens ZIP og mellom installer-versjoner. Skolens regler for hvilke programmer som kan kjøres, gjelder også en installer for én bruker. [electron-builder 26: NSIS](https://www.electron.build/v26/docs/nsis/).

Piloten er ikke kodesignert. Ingen sertifikat- eller signeringstjeneste er valgt. SHA-512 i oppdateringsflyten og de separate SHA-256-kontrollsummene kontrollerer filinnholdet, men erstatter ikke en verifisert utgiversignatur. Det legges ikke inn en omgåelse av signaturkontroll. Kodesignering og kontroll av signert oppdatering må avklares før bred produksjonsdistribusjon. [electron-builder 26: Windows-signering](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/).

## Før en utgivelse publiseres

1. Bygg og test den taggede versjonen i Actions.
2. Last ned utkastets installer på en separat PC og test oppstart, eksisterende notater, automatisk nedlasting og installasjon ved avslutning og valgt omstart.
3. Kontroller at `latest.yml`, `.exe.blockmap` og installer samsvarer, og at pakken ikke inneholder notater, øktdata, API-nøkler eller en paret fjernagent. Kontroller signering når en signert produksjonskanal er innført.
4. Skriv korte utgivelsesnotater og publiser utkastet. Offentlige nedlastinger skal gå til GitHub Release, ikke en midlertidig adresse på en elev-PC.

Hvis kildekoden senere gjøres privat, må distribusjonen fortsatt ha en egen offentlig nedlastingskanal eller en autentisert tjeneste med tilgang per bruker. En felles personlig GitHub-token skal aldri bygges inn i klientene. Repoet har foreløpig `UNLICENSED`; offentlig synlighet innfører ikke en ny åpen kildekode-lisens.
