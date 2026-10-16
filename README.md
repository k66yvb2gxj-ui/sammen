# Sammen – Windows-pilot 0.4.0

Et felles arbeidsrom for prosjekter, notater, tankekart, kilder, flashcards og quizer. Kildekoden ligger i [GitHub-repoet](https://github.com/k66yvb2gxj-ui/sammen). Kontrollerte Windows-utgivelser publiseres på [GitHub Releases](https://github.com/k66yvb2gxj-ui/sammen/releases).

## Bruk appen

Windows-pakken bygges som en installer for den innloggede brukeren og en portabel ZIP. Installer `.exe`-pakken for å få automatiske oppdateringer. For ZIP: pakk ut alle filene og åpne `Sammen.exe`; denne varianten oppdateres manuelt. Ingen separat Node-installasjon kreves. Egne data lagres i Windows-brukerens Sammen-appdatamappe. Desktop-appen starter med et tomt prosjekt; sandboxen bruker separate demonstrasjonsdata.

- **Brain:** Prosjektene har hver sitt område i en zoombar graf. Klikk på en sirkel for å åpne filen. Rull for å zoome, dra bakgrunnen for å flytte visningen, eller bruk +/−/Tilpass. Prosjekttitlene fader ved nærzoom. Dobbeltklikk på et tomt sted for å få opp knapper for et nytt prosjekt.
- **Arbeidsrom:** Velg **Min Brain** eller **Offentlig Brain** over grafen. **+** oppretter en egen Brain for inviterte, eller lar deg bli med via adresse og kode. Hver Brain har egen database; private filer kopieres ikke til delte rom. Grafer, tankekartvisninger og samtaleutkast holdes adskilt.
- **Brukerikoner:** Velg figur og pastellfarge under **Profil**. Små ikoner ved filene viser bidragsytere; åpne ikonene i filen for navn og bidragstidspunkt. Bare faktiske redigeringer registreres. Gamle forfatternavn vises som eldre oppføringer uten å finne på brukeridentitet eller historikk. Nye KI-utkast beholder KI-merkingen.
- **Medlemmer:** Ikonene over Brain-grafen åpner en medlemsoversikt. Personer som har blitt med, beholdes i listen når de kobler fra; tilkoblingsstatus vises separat. Listen gjelder den valgte Brainen. Profilene er lokale identiteter, ikke verifiserte skolekontoer eller en oversikt over tilgangsrettigheter.
- **Tankekart:** Jevn zoom og direkte redigering på lerretet. Tab lager underpunkt, Enter lager sidepunkt, og dobbeltklikk/F2 redigerer tekst. Punkter kan flyttes, skjules, kobles og formateres. Ctrl+S lagrer også aktiv punkttekst.
- **Filer og kilder:** **Importer → Dokumenter** tar imot DOCX, Markdown, tekst og HTML. Originalen beholdes lokalt, mens tekstkopien ligger i Brain. Oppgi lenker eller kildefiler fra samme prosjekt i filens **Kilder**-felt.
- **Flashcards:** **Kort**, **Øv** og **Quiz** bruker kortene i prosjektet. Quizer har flervalg, skriftlige svar og sant/usant. Personlig repetisjon lagres lokalt; quizresultater beholdes i økten.

## ChatGPT i sidepanelet

**ChatGPT**-knappen åpner et sidepanel som kan skjules igjen. Samtaler opprettes per prosjekt. Velg bestemte Brain-filer som kontekst; bare valgte filer sendes, opptil 30 per melding. Svar lagres i Brain som KI-utkast med kildereferanser når svaret har det.

Desktop-panelet bruker den eksisterende **Sign in with ChatGPT**-integrasjonen med OAuth-innlogging og eksplisitt samtykke i nettleseren. Hver elev trenger sin egen kvalifiserte konto; bruk belaster kvoten på kontoen eleven logger inn med. Modeller hentes fra den tilkoblede kontoen. Tidligere samtaler fra ChatGPT importeres ikke.

Sandboxen viser grensesnittet og holder innlogging og sending deaktivert. Live innlogging, kontotilgang og et ekte ChatGPT-svar er ikke verifisert i denne versjonen. Automatiserte OAuth- og strømmetester bruker lokale testtjenester.

## Samarbeid og OneNote

Opprett en egen Brain med **+** og velg **Inviter → Lokalt → Del Brain**. Alle prosjektene i denne Brainen deles på et tilgjengelig lokalnett. Medelever bruker **+ → Bli med**, adresse og invitasjonskode. Vertens app må være åpen, og nettverket må tillate forbindelsen. Appen endrer ikke brannmuren. Delte Brains fortsetter å synkronisere i bakgrunnen når du velger Min Brain.

**Samarbeid → Internett** bruker en felles HTTPS-server med varig disk. Serverpakken og Docker/Caddy-oppsettet ligger i [server/README.md](server/README.md); offentlig hosting er ikke konfigurert. Inviterte deltakere har redigeringstilgang. Notater, titler, kilder og tankekart fletter samtidige endringer med Yjs, lagres automatisk og sender uavleverte endringer etter gjenoppkobling. Importerte originalfiler følger ikke automatisk med til andre PC-er.

**Offentlig Brain** er felles for alle som kobler til samme offentlige Sammen-server. Den er skrivebeskyttet før tilkobling. Serveransvarlig må aktivere `SAMMEN_PUBLIC_BRAIN=1`; klienten bruker serveradressen under **Koble til**, eventuelt `SAMMEN_PUBLIC_BRAIN_URL`. Ingen offentlig server er publisert eller valgt i denne endringen. Inviterte Brains bruker en hemmelig invitasjon, ikke innlogging med godkjente personkontoer. Den som får invitasjonen, kan redigere. Lagrede klientøkter varer opptil åtte timer før ny tilkobling kan være nødvendig.

**Importer → OneNote** kopierer valgte sider til Brain og beholder kildeadressen. Lokal lesing bruker `OneNote.Application`, så OneNote desktop må være tilgjengelig for Windows-brukeren. Kalender- og ukeplansider kan importeres som notater; de blir ikke automatisk synkronisert eller gjort om til kalenderhendelser.

Under **Profil → Denne PC-en** kan brukeren eksplisitt starte den medfølgende offisielle Remote Desktop Commander-agenten. Nettleseren håndterer innlogging og godkjenning av paringskode. Enheten tilhører kontoen som godkjenner paringen; separate kontoer gir ikke automatisk tilgang til hverandres PC-er. Ingen økter eller nøkler følger pakken. Agenten får fil- og kommandotilgang med brukerens rettigheter, stoppes når appen lukkes, og starter ikke automatisk. Lokal OneNote-import trenger ikke fjernagenten. [Offisiell paringsguide](https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md).

## Administrasjon

**Profil → Admin** åpner en oversikt over brukere, Brains, prosjekter, filer og siste aktivitet på den tilkoblede fellesromserveren. Fanene **Brukere**, **Brains** og **Aktivitet** kan søkes i. Panelet gir lesetilgang; det henter ingen private Brains eller filer fra elev-PC-ene.

Serveransvarlig må aktivere en egen `SAMMEN_ADMIN_KEY` på minst 24 tegn, forskjellig fra opprettelsesnøkkelen. Bruk serverens HTTPS-adresse og denne nøkkelen i adminpanelet. Invitasjoner og vanlige deltakerøkter gir ingen admintilgang. «Husk på denne PC-en» er av som standard; velges det, beskytter Windows nøkkelen med operativsystemets kryptering. Sandboxen husker den bare i økten.

Aktivitetsloggen starter når admin aktiveres og beholder de siste 5 000 hendelsene. Den viser profiler, rom og eventuelle fil-/prosjekttitler, uten filinnhold eller nøkler. Den er en aktivitetsoversikt, ikke en komplett revisjonsjournal. Ingen produksjonsserver eller personlig adminnøkkel er konfigurert ennå. Se [server/README.md](server/README.md).

## Nye versjoner

Fra 0.4.0 sjekker den installerte Windows-appen etter en nyere, publisert stabil GitHub Release og laster den ned automatisk. `electron-updater` kontrollerer nedlastingen mot SHA-512 i oppdateringsmetadataene. Når pakken er klar, installeres den ved normal avslutning, eller brukeren kan velge **Start på nytt og oppdater**. Før avslutning ber appen redigeringsvinduet lagre arbeidet og stopper fjernagenten og samarbeidsforbindelsen.

Den eksisterende ZIP-versjonen 0.3.0 kan ikke oppdatere seg selv. Disse brukerne må installere 0.4.0 med `.exe` én gang. Nyere ZIP-versjoner og sandboxen har bare oppdateringssjekk eller manuell nedlasting; grunnen vises under **Profil → Oppdateringer**.

GitHub Actions beholder installer, ZIP, `latest.yml` og `.exe.blockmap`. Nye utgivelser opprettes som utkast for kontroll; eksisterende utgivelser og filer beholdes. Piloten er ikke kodesignert, og ingen signeringstjeneste er valgt. SHA-512 erstatter ikke en verifisert utgiversignatur. En full oppgradering med den ferdige installeren er ennå ikke verifisert. Se [docs/UPDATES.md](docs/UPDATES.md).

## Utvikling og kontroll

Bruk Node.js 22.23.3 og npm. Kjør `npm ci`, `npm run build:collaboration`, `npm test` og `npm start`. Før Windows-bygg: `npm run prepare:remote` og `npm run build`. Fjernagenten låses til Desktop Commander 0.3.0 med offisiell Node-runtime og SHA-256-kontroll av Node-arkivet. Browser-bundelen og fjernagenten beholder tredjepartslisensene sine.

202 automatiserte tester er bestått, inkludert isolerte Brains, bidragsikoner, medlemskap, samarbeid med to klienter og adminklient mot server over verifisert HTTPS. Live ChatGPT, oppgradering på en annen fysisk PC og skolemaskinenes kjøreregler er fortsatt uprøvd. Brain-valget, brukerikonene og adminpanelet må inngå i en ny Windows-utgivelse før eksisterende installasjoner får dem. Appen er en pilot uten betalingstjeneste. Kildekoden er foreløpig `UNLICENSED`.
