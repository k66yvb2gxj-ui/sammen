# Sammen fellesrom over internett

Denne serveren lagrer delte prosjekter og Yjs-dokumenter i SQLite på en varig disk. Elevene kobler til fra Windows-appen via HTTPS. En invitasjonskode gir tilgang til ett fellesrom. Alle inviterte kan redigere; det er foreløpig ingen skolekontoer eller separate lese-/skriveroller.

## Publisering

Bruk en server eller containerplattform med varig disk. Domenet må peke til serveren. Docker Compose-pakken bruker Caddy til HTTPS og automatisk sertifikatfornyelse. Port 80 og 443 må kunne nås på serversiden.

1. Kopier `.env.example` til `.env` i denne mappen.
2. Sett `SAMMEN_DOMAIN` til domenet ditt og `SAMMEN_CREATE_KEY` til en privat tilfeldig nøkkel på minst 24 tegn. Nøkkelen brukes bare av den som oppretter fellesrom; elevene trenger invitasjonen.
3. Kjør `docker compose --env-file .env up -d --build` i denne mappen.
4. Kontroller `https://ditt-domene/health`.
5. I Sammen: opprett en egen Brain med **+** over grafen. Velg **Inviter → Internett**, skriv serveradressen og opprettelsesnøkkelen, og opprett fellesrom. Alle prosjektene i denne Brainen deles. Del adressen og invitasjonskoden med ønskede deltakere. Medelever velger **+ → Bli med**.

Elevenes apper bruker vanlig sertifikatvalidering for internettserveren. Det trengs ingen portåpning eller fjernstyring på elev-PC-ene. Min Brain holdes adskilt; bare innhold i den valgte inviterte Brainen sendes. Rommet fortsetter å fungere når den som opprettet det lukker appen. Eldre klienters deling av ett prosjekt støttes fortsatt.

## Offentlig Brain

Sett `SAMMEN_PUBLIC_BRAIN=1` i `.env` for å aktivere én separat offentlig Brain på serveren. Standard er av. Klientene velger **Offentlig Brain → Koble til** og bruker samme HTTPS-serveradresse. `SAMMEN_PUBLIC_BRAIN_URL` kan også angi adressen ved oppstart av desktop-klienten. Min Brain og inviterte rom kopieres aldri automatisk hit.

`POST /api/public-brain/join` gir en midlertidig klientøkt uten invitasjonskode eller opprettelsesnøkkel. Alle som når denne serveren, kan lese og redigere den offentlige Brainen. Det er ingen kontoidentitet eller moderering ennå; serveroperatøren må velge om dette skal aktiveres. Data lagres separat i `public-brain.sqlite`. Ingen offentlig server er satt opp av kodeendringen.

## Drift og begrensninger

Ta sikkerhetskopi av `sammen-data`-volumet. Serveren krever varig disk og én skriveprosess per datamappe; dette oppsettet skal ikke skaleres til flere parallelle containere som skriver de samme SQLite-filene. Siste mottatte arbeidsrom og uavleverte redigeringsoppdateringer lagres lokalt og forsøkes synkronisert igjen når forbindelsen er tilbake. En klientøkt varer opptil åtte timer; utløpt økt krever ny tilkobling. Lokale kopier slettes ikke ved vanlig avslutning.

Opprettelsesnøkkelen hindrer at hvem som helst fyller serveren med nye rom. Standardgrensen er 100 rom og 12 nye rom per time per direkte klientadresse. Invitasjonen gir redigeringstilgang: del den bare med ønskede deltakere. Skolekontoer, invitasjonsrotasjon, administrasjon av rom og brukerstyrt sletting er videre arbeid. Ingen ekstern server eller kostnad er opprettet automatisk av denne pakken.

Koden bruker [Yjs](https://docs.yjs.dev/getting-started/a-collaborative-editor) til sammenslåing av samtidige endringer og [Caddy](https://caddyserver.com/docs/automatic-https) til HTTPS i dette driftsoppsettet.
