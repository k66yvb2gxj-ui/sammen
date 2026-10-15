# Sammen fellesrom over internett

Denne serveren lagrer delte prosjekter og Yjs-dokumenter i SQLite på en varig disk. Elevene kobler til fra Windows-appen via HTTPS. En invitasjonskode gir tilgang til ett fellesrom. Alle inviterte kan redigere; det er foreløpig ingen skolekontoer eller separate lese-/skriveroller.

## Publisering

Bruk en server eller containerplattform med varig disk. Domenet må peke til serveren. Docker Compose-pakken bruker Caddy til HTTPS og automatisk sertifikatfornyelse. Port 80 og 443 må kunne nås på serversiden.

1. Kopier `.env.example` til `.env` i denne mappen.
2. Sett `SAMMEN_DOMAIN` til domenet ditt og `SAMMEN_CREATE_KEY` til en privat tilfeldig nøkkel på minst 24 tegn. Nøkkelen brukes bare av den som oppretter fellesrom; elevene trenger invitasjonen.
3. Kjør `docker compose --env-file .env up -d --build` i denne mappen.
4. Kontroller `https://ditt-domene/health`.
5. I Sammen: **Samarbeid → Internett**, velg prosjekt, skriv serveradressen og opprettelsesnøkkelen, og opprett fellesrom. Del adressen og invitasjonskoden med klassen. Medelever velger **Bli med**.

Elevenes apper bruker vanlig sertifikatvalidering for internettserveren. Det trengs ingen portåpning eller fjernstyring på elev-PC-ene. Vertens opprinnelige lokale prosjekt beholdes; fellesrommet er en egen kopi. Rommet fortsetter å fungere når den som opprettet det lukker appen.

## Drift og begrensninger

Ta sikkerhetskopi av `sammen-data`-volumet. Serveren krever varig disk og én skriveprosess per datamappe; dette oppsettet skal ikke skaleres til flere parallelle containere som skriver de samme SQLite-filene. Nedlastet hovedprosjekt bevares ikke automatisk som en komplett lokal offlinekopi hos hver elev, men uavleverte redigeringsoppdateringer lagres lokalt og forsøkes sendt igjen når forbindelsen er tilbake.

Opprettelsesnøkkelen hindrer at hvem som helst fyller serveren med nye rom. Standardgrensen er 100 rom og 12 nye rom per time per direkte klientadresse. Invitasjonen gir redigeringstilgang: del den bare med ønskede deltakere. Skolekontoer, invitasjonsrotasjon, administrasjon av rom og brukerstyrt sletting er videre arbeid. Ingen ekstern server eller kostnad er opprettet automatisk av denne pakken.

Koden bruker [Yjs](https://docs.yjs.dev/getting-started/a-collaborative-editor) til sammenslåing av samtidige endringer og [Caddy](https://caddyserver.com/docs/automatic-https) til HTTPS i dette driftsoppsettet.
