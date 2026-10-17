# Fast felles Brain på Render

Dette er et klargjort oppsett, ikke en publisert tjeneste. Eieren må koble sin egen Render-konto til kodearkivet og godkjenne betalingen før tjenesten opprettes. Ingen serveradresse eller kostnad er opprettet av disse filene.

## Oppsett og pris

[`render.yaml`](../render.yaml) oppretter én Docker-tjeneste i Frankfurt med 0,5 CPU, 512 MB minne og 1 GB varig disk. Beregnet grunnpris per 17. oktober 2026 er **7,25 USD per måned**: 7 USD for serveren og 0,25 USD for disken, før avgifter, eventuell ekstra båndbredde og andre kontotjenester. Kontroller gjeldende pris i Render før oppretting. Dette er et startoppsett; kapasiteten er ikke belastningstestet. Se [Render-priser](https://render.com/pricing) og [Blueprint-felter](https://render.com/docs/blueprint-spec).

Render tildeler en adresse som `https://sammen-brain-….onrender.com` med HTTPS. Den faktiske adressen vises etter oppretting, så eget domenekjøp er ikke nødvendig. Render håndterer TLS; Caddy og Compose brukes ikke i dette oppsettet. Se [Render Web Services](https://render.com/docs/web-services).

## Opprette tjenesten

1. Sørg for at kodearkivets valgte gren inneholder denne `render.yaml` og serverkoden som følger med. Lokale, upubliserte filer er ikke tilgjengelige for Render.
2. Logg inn på eierens Render-konto, koble kodearkivet og opprett en Blueprint fra den valgte grenen. Gå gjennom region, disk og pris, og godkjenn den betalte tjenesten før oppretting.
3. Behold én instans. Automatiske kodeutrullinger og forhåndsvisningsmiljøer er slått av. Offentlig Brain og admin-API er også slått av. Første oppretting starter likevel en bygging og utrulling; senere oppdateringer startes manuelt.
4. Render lager `SAMMEN_CREATE_KEY` som en hemmelig miljøvariabel. Oppbevar den privat. Bare den som oppretter Brains trenger denne nøkkelen; den skal ikke legges i kildekoden eller deles med elevene.
5. Bruk HTTPS-adressen Render viser. Serveren bruker `RENDER_EXTERNAL_URL` når `SAMMEN_PUBLIC_ORIGIN` ikke er satt. Ved senere bytte av offentlig adresse må `SAMMEN_PUBLIC_ORIGIN` settes til den nye HTTPS-adressen.
6. Kontroller at `/health` svarer med `ok: true`, og gjennomfør kontrollen under før elevbruk.

## Kontroll før bruk

Appdata skal lagres i `/var/data/sammen`, under den varige disken `/var/data`. Docker kjører fortsatt som brukeren `node`. **Skriverettighetene på Render-disken er ikke prøvd i et virkelig driftsmiljø.** Kontroller at oppstart oppretter datamappen uten `EACCES`, og at et opprettet rom overlever omstart. Byggingens rettigheter på `/data` beviser ikke rettigheter på den monterte disken. Eventuelle diskrettigheter må løses før elevbruk uten å endre applikasjonen til å kjøre som root.

Lag deretter en egen Brain i Windows-appen med **+** over grafen. Velg **Inviter → Internett**, oppgi serveradressen og opprettelsesnøkkelen, og opprett fellesrommet. Alle prosjektene i denne Brainen deles. Deltakerne bruker **+ → Bli med** og invitasjonen. Invitasjonen inneholder serveradressen, så deltakerne trenger ikke opprettelsesnøkkelen.

Kontroller med to klienter at begge ser endringer, at samarbeidet fortsetter når oppretterens app er lukket, og at innholdet finnes etter serveromstart. `/health` alene kontrollerer ikke at data faktisk kan skrives eller gjenopprettes. Nettlesersandboxen er en lokal forhåndsvisning; tilkoblingskontrollen skal gjøres med Windows-appen.

Invitasjonen gir alle mottakere redigeringstilgang. Skolekontoer, separate lese-/skriveroller og tilbakekalling av én deltakers tilgang finnes ikke ennå. Standardgrensen er 30 klientøkter per invitert rom. Planlegg også en sikkerhetskopi og prøv gjenoppretting før viktige data legges inn.

## Drift og sikkerhetskopi

SQLite krever én skriveprosess per datamappe. Ikke legg til flere instanser. Varig disk gir korte avbrudd under utrulling. Bare innhold under diskens monteringssti beholdes ved omstart. Se [Render Persistent Disks](https://render.com/docs/disks).

Det følger ikke med automatisk sikkerhetskopiering. Bruk en av disse metodene:

- Lag en konsistent kopi av hver database med et verktøy som bruker [SQLite Online Backup API](https://www.sqlite.org/backup.html), og flytt de ferdige kopiene til separat, beskyttet lagring.
- Stans serverens skriveprosess helt før en konsistent kopi av datamappen tas. Behold eventuelle `.sqlite-wal`- og `.sqlite-shm`-filer sammen med databasen. Avtal hvordan disken skal nås mens prosessen er stoppet; vanlig tjenestesuspendering gir ikke nødvendigvis en tilgjengelig shell.

**Kopier aldri bare en aktiv `.sqlite`-fil.** Siste endringer kan ligge i WAL-filen. Se [SQLite WAL](https://www.sqlite.org/wal.html). Render-diskens snapshots erstatter ikke en prøvd databasesikkerhetskopi; Render fraråder disk-snapshot-gjenoppretting for egne databaser.

Ved gjenoppretting: stans alle skriverne, ta vare på nåværende datamappe, gjenopprett det valgte konsistente backupsettet i en tom datamappe med riktige eiere/rettigheter, og start serveren igjen. Ikke bland gamle WAL-filer med databaser fra et annet backupsett. Kontroller rom, innhold og redigering fra to klienter før tjenesten tas i bruk. Ta vare på sikkerhetskopier utenfor selve Render-disken.
