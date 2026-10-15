# Sammen – Windows-prototype 0.1

Et desktop-arbeidsrom for elever: prosjekter, research, notater, tankekart, flashcards og quizer. Denne versjonen er en kjørbar pilot. Den har ingen betalingstjeneste eller publisert skyserver.

Grensesnittet oppdatert 14. oktober viser Brain som en graf. Klikk på en sirkel for å åpne filen. Tankekart redigeres direkte på et lerret; Flashcards har Kort, Øv og Quiz. Chat og Innstillinger er tatt ut av navigasjonen mens integrasjonene videreutvikles. Avsnittene om KI, OneNote og LAN nedenfor beskriver eksisterende integrasjonskode fra den tidligere piloten; disse oppsettskjermene er foreløpig skjult. Den tidligere Windows-ZIP-en oppdateres ved neste pakkebygg.

## Start

Pakk ut `Sammen-Windows-0.1.0.zip` i en fast mappe, og åpne `Sammen.exe`. Behold filene rundt programmet i samme mappe. Pakken trenger ingen vanlig installasjon eller administratorrettigheter. Node.js og database følger med. Det opprettes et tomt prosjekt; dine data lagres lokalt under Windows-brukerens appdatamappe for Sammen.

1. Opprett et prosjekt for et fag eller en oppgave.
2. Skriv et notat i Brain, eller importer DOCX, Markdown, tekst eller HTML.
3. Hent kilder i Research og lagre de aktuelle treffene i Brain.
4. Lag spørsmål og svar i Flashcards. Hver elev har sin egen repetisjonsplan.
5. Øv med kortene, eller lag en quiz med flervalg, skriftlige svar og sant/usant.

KI-svar lagres automatisk i Brain som **KI-utkast / ikke kontrollert**. Referansene viser hvilke utdrag modellen fikk. De beviser ikke at alle påstander er riktige; kontroller originalkildene.

## OneNote: samme lokale henting som den eksisterende PC-løsningen

Åpne Innstillinger → **Hent fra OneNote**. Søk i sidenavn og full rute, velg inntil 20 sider og importer dem i valgt prosjekt. Leseren bruker `OneNote.Application`, `GetHierarchy` og `GetPageContent`, som den eksisterende lokale leseren på brukerens PC. Den følger med installasjonen og trenger ingen Microsoft Graph-app eller separat Node-installasjon.

Krav: Windows, installert OneNote desktop, notatbøkene åpne i samme Windows-brukersesjon, og tillatelse til å kjøre det medfølgende PowerShell-skriptet. Skole-PC-er kan blokkere dette. Appen omgår ingen skolepolicy.

Bare valgte sider leses. OneNote endres ikke. Tekst, tabellceller og tilgjengelig OCR blir importert; bilder, vedlegg, håndskrift og layout bevares ikke fullstendig. Sidene er kopier: importer den samme siden igjen for å oppdatere kopien. Det er ingen automatisk toveis synkronisering. Kildelenken åpner den opprinnelige siden i OneNote.

[Microsofts lokale OneNote-grensesnitt](https://learn.microsoft.com/en-us/office/client-developer/onenote/application-interface-onenote).

## KI-tilgang

**Eget ChatGPT-abonnement:** Velg denne forbindelsen, trykk Continue with ChatGPT og fullfør OpenAIs innlogging i nettleseren. Sammen registrerer sin egen app; eksisterende Hermes- eller Codex-tokens kopieres ikke. Modellisten hentes for den aktuelle kontoen. GPT-6 Luna brukes bare dersom den finnes i listen. Tilgjengelighet avhenger av plan og utrulling. Tokens beskyttes lokalt med Windows-kryptering og følger ikke prosjektfiler eller gruppesynkronisering.

[Offisiell abonnementstilgang](https://developers.openai.com/siwc/token-sharing-open-source), [modelltilgang og forespørsler](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

**Lokal Ollama:** Installer Ollama separat, last ned en modell som passer PC-en, og velg den i Sammen. Appen kobler bare til `http://127.0.0.1:11434`. Ingen modell eller flere gigabyte med modellvekter lastes ned automatisk. Lokal kjøring har ingen API-avgift per melding, men krever maskinressurser. Cloud-modeller i Ollama er et eget tilbud.

[Ollama](https://ollama.com/), [priser og lokal kjøring](https://ollama.com/pricing).

Ingen live ChatGPT-innlogging eller inferens med en ekte bruker er gjennomført under byggingen. Innlogging, scopes, kryptering, refresh og strømmer er testet med kontrollerte mocks. Den første ekte innloggingen må gjøres av eleven selv.

## Samarbeid på lokalt nettverk

Verten åpner Innstillinger, velger ett prosjekt og trykker **Start deling av prosjekt**. Del HTTPS-adressen og invitasjonskoden med de andre. De skriver inn begge under **Bli med i prosjekt**. Invitasjonen binder forbindelsen til vertens sertifikat. Notater, kilder, kort og prosjektets samtaler deles. Hver elev kjører sin egen KI lokalt med egen tilgang.

Bare valgt prosjekt deles. Vertsappen må være åpen, og skole-/hjemmenettverket må tillate forbindelsen. Appen åpner ikke brannmurregler, porter på ruteren eller varig fjernstyring. Dette er en tidlig LAN-funksjon, uten skolekontoer, roller, internettserver eller sanntidsredigering av samme avsnitt. Notater har revisjonskontroll: eldre utkast kan ikke overskrive nyere versjoner.

Når en elev forlater gruppen, vises elevens egne lokale prosjekter igjen. Gruppen lagres på verts-PC-en. Ta prosjektkopier med eksport; klientens delte bibliotek er ikke en automatisk offline-replika.

## Dokumenter og eksport

Word-import støtter `.docx` og trekker ut tekst. Eldre `.doc` må lagres som DOCX først. Ved lokal import oppbevares originalfilen på PC-en som importerte den. En tilkoblet gruppeklient sender bare dokumentteksten og beholder ingen originalkopi i Sammen. Delt prosjekt og JSON-eksport inkluderer dokumentteksten, ikke originalens binærdata, bilder eller layout.

Eksport inkluderer notater, kilder, tankekart, flashcards og samtaler. Personlige repetisjonsdata og KI-innlogging følger ikke med. Prosjektimport oppretter en separat kopi og overskriver ikke eksisterende prosjekter.

## Research og senere integrasjoner

Research henter norsk Wikipedia-innledning, Crossref-bibliografi og PubMed-abstracts. Crossref-treff er merket som metadata; de utgis ikke for fulltekst. Søket er avgrenset, og er ingen generell nettleser eller uttømmende litteraturgjennomgang.

Arbeidsmåter fra research-skills har inspirert kildehåndteringen. Ingen proprietære Codex-pluginpakker eller brukerspesifikke fagkart er kopiert inn i appen.

Remote Desktop Commander er ikke aktivert eller pakket inn i denne piloten. Den lokale OneNote-leseren kjører på hver elevs egen PC. En eventuell ekstern fjernkobling krever separat konto, paring, samtykke og vurdering av tjenestens vilkår. Det skal ikke være nødvendig å gi generell PC-tilgang for å importere egne notater.

## Betaling og billige modeller

Ingen betaling kan gjennomføres i prototypen. Bruk av egen ChatGPT-plan skal være tilgjengelig uten å kjøpe en appoppgradering. En senere betalt KI-pakke må bruke separat ordinær API-tilgang, med egne grenser og priser. Betalte/eksternt hostede abonnementstilkoblinger må avklares med OpenAI før lansering. [SIWC-vilkår, punkt 2](https://openai.com/policies/sign-in-with-chatgpt-terms/).

Prisgrunnlag kontrollert 13. oktober 2026: GPT-6 Luna har standardpris **USD 0,10 inn / USD 0,50 ut per million tokens** for kort kontekst. Verktøy og lengre kontekst kan gi tillegg. [Modellpriser](https://developers.openai.com/api/docs/models/gpt-6-luna).

Gratis API-kvoter er valgfrie kandidater, ikke et løfte om gratis AI for alle elever. Alderskrav, region, databruk, rate limits og kontotilgang må kontrolleres for den valgte tjenesten før integrasjon. Lokal Ollama er allerede støttet.

## Utvikling

Krever Node.js 22.12+ og npm. Fra kildekodemappen:

```powershell
npm ci
npm start
npm test
npm run build
```

Electron 43.7.10 er valgt som runtime. Den ferdige Windows-pakken trenger ikke utviklingsverktøy. Programmet er ikke kodesignert. En tidligere Electron 44.7.1-fil ble blokkert av Windows Defender og brukes ikke i pakken. Alternativet er kontrollert mot offisiell sjekksum, skannet og startet normalt uten å endre Windows-sikkerhetsinnstillingene. NSIS-installeren kunne ikke bygges på denne maskinen; derfor leveres programmet som en portabel ZIP-pakke.

`scripts/package-smoke.mjs` starter den pakkede Windows-appen normalt og kontrollerer grensesnitt, lagring, personlige repetisjoner og den medfølgende OneNote-leserens registreringsdiagnose. `scripts/browser-smoke.mjs` kontrollerer flere skjermbilder og redigeringstilstander med en lokal testadapter. Sett `PLAYWRIGHT_MODULE` til en installert Playwright-modul før du kjører disse med Node.js. De bruker egne testprofiler under `work`; demonstrasjonsnotater følger ikke Windows-pakken. Ingen av kontrollene logger inn i en ekte KI-konto eller leser faktiske OneNote-sider.

Viktige neste kontroller før klassebruk: ekte ChatGPT-innlogging, valgt OneNote-side på hver PC, LAN mellom to fysiske skole-PC-er og sikkerhetskopi/gjenoppretting. Deretter kan internettbasert synkronisering, automatiske flashcards, flere leverandører, fjernintegrasjon og betaling bygges videre.
