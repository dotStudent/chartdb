# SQLite-Dateiimport in ChartDB

Im Dialog für ein neues Diagramm **SQLite** und anschließend **SQLite File** beziehungsweise **SQLite-Datei** wählen. Eine `.db`-, `.sqlite`- oder `.sqlite3`-Datei auswählen oder ablegen. Sobald das Schema geladen ist, **Importieren** wählen. Bei größeren Modellen bietet ChartDB wie beim Smart-Query-Import eine Tabellenauswahl an. Im Editor lässt sich über **Datenbank importieren → SQLite-Datei** ein vorhandenes SQLite- oder generisches Diagramm ergänzen.

Importierte Ansichten sind standardmäßig ausgeblendet. Über **Ansicht → Datenbankansichten → An** erscheinen sie im Diagramm und unter **Tabellen**. Ein erneuter Import ist dafür nicht nötig.

## Technischer Aufbau

Ein Web Worker liest die Datei und öffnet sie mit sql.js. Vite legt das WASM-Modul als versioniertes Asset im eigenen Produktionsbuild ab. Der Worker nutzt feste Schemaabfragen, deaktiviert vertrauenswürdige Schema-Erweiterungen mit `trusted_schema=OFF` und setzt `query_only=ON`. Er liest keine Anwendungszeilen und führt keine aus der Datei übernommenen SQL-Skripte aus. Unterstützte Ansichten werden über SQLite-Schemametadaten aufgelöst, ohne ihre Daten abzufragen. Die Datei und die daraus ermittelten Metadaten werden beim Import nicht übertragen.

Die Metadatenextraktion ist vom Dialog getrennt und erzeugt das gemeinsame `DatabaseMetadata`-Format. ChartDB verwendet anschließend den bestehenden Metadatenimport für Diagramm, Layout und Tabellenauswahl. Die SQLite Smart Query bleibt verfügbar. Die Datei kann deshalb weiterhin aus einem extern erzeugten, abstrahierten Oracle-Modell stammen. Ein späterer Importmechanismus kann denselben Extraktor und Diagrammimport aufrufen.

## Entwicklung und Tests

Node.js 24 und npm verwenden.

```sh
npm ci
npm run dev
npm run lint
npx tsc -b
npm run test:ci
npm run build
docker build --build-arg VITE_DISABLE_ANALYTICS=true --build-arg VITE_HIDE_CHARTDB_CLOUD=true -t chartdb-sqlite:test .
```

Für einen manuellen Test lässt sich mit der SQLite-CLI eine Beispieldatei erzeugen.

```sh
sqlite3 probe.sqlite 'CREATE TABLE abteilung (id INTEGER PRIMARY KEY); CREATE TABLE person (id INTEGER PRIMARY KEY, abteilung_id INTEGER REFERENCES abteilung(id)); CREATE VIEW personenuebersicht AS SELECT id, abteilung_id FROM person;'
```

Nach dem Import erscheinen zwei Tabellen und eine 1:n-Beziehung. Mit eingeblendeten Datenbankansichten erscheint zusätzlich `personenuebersicht`. Dieselbe Datei lässt sich per Dateiauswahl, per Drag-and-drop und über das Editor-Menü testen. Die Dateien für die automatisierten Tests entstehen im Arbeitsspeicher.

## Veröffentlichung mit GitHub Actions

Der Workflow **Publish** baut das bestehende Dockerfile für `linux/amd64` und `linux/arm64` und veröffentlicht nach den Projekttests unter `ghcr.io/dotstudent/chartdb`.

| Git-Referenz                          | Image-Tags                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `feature/sqlite-file-import`          | `feature-sqlite-file-import`, `sha-<vollständiger Commit-SHA>`                        |
| `main`                                | `main`, `sha-<vollständiger Commit-SHA>`                                              |
| Release-Tag, beispielsweise `v1.22.0` | `1.22.0`, `sha-<vollständiger Commit-SHA>`, bei stabilen Releases zusätzlich `latest` |

GitHub Actions im Fork muss aktiviert sein. Der Workflow verwendet `GITHUB_TOKEN` mit `contents: read` und `packages: write`. Falls das GHCR-Paket bereits existiert, unter **Package settings → Manage Actions access** dem Fork Schreibzugriff auf das Paket geben. Für anonyme Pulls muss das Paket öffentlich sein. Für ein privates Paket muss der Server bei GHCR mit einem Konto angemeldet sein, das Leserechte hat. Bei einem klassischen PAT ist dafür `read:packages` erforderlich. Release-Tags können im Fork manuell auf freigegebene Commits gesetzt werden.

## Paralleler Test auf Debian 13

Die Datei `compose.sqlite-test.yaml` aus dem Fork nach `/opt/chartdb` auf den ChartDB-Server kopieren und als eigenes Projekt starten.

```sh
cd /opt/chartdb
docker compose -p chartdb-sqlite-test -f compose.sqlite-test.yaml pull
docker compose -p chartdb-sqlite-test -f compose.sqlite-test.yaml up -d
docker compose -p chartdb-sqlite-test -f compose.sqlite-test.yaml ps
```

Die Instanz bindet Port 8086 an Loopback. Vom externen Rechner aus über SSH aufrufen.

```sh
ssh -N -L 8086:127.0.0.1:8086 <ssh-host>
```

Anschließend im selben Rechner-Browser `http://localhost:8086` öffnen. Die produktive Instanz auf 8085 und der Cloudflare-Tunnel laufen parallel weiter. ChartDB speichert Diagramme im Browser. Die Test-URL hat ihren eigenen Browser-Speicher.

Für ein Update erneut `pull` und `up -d` ausführen. Für reproduzierbare Tests kann `CHARTDB_TEST_IMAGE` in beiden Aufrufen auf einen SHA-Tag oder Digest gesetzt werden. Die Testinstanz lässt sich mit `docker compose -p chartdb-sqlite-test -f compose.sqlite-test.yaml down` entfernen.

## Direkter Test auf Port 8085 und Rollback

Diesen Weg wählen, wenn die bestehende Instanz für den Test umgestellt werden kann. Beim Neustart des Dienstes ist ChartDB kurz nicht erreichbar. Die vorhandene Portzuordnung und der Cloudflare-Zugang werden weiterverwendet.

1. Unter `/opt/chartdb` mit `sudo docker compose ps chartdb` den laufenden Dienst prüfen. Wichtige Diagramme vor dem Wechsel über die Oberfläche exportieren.
2. Die vorhandene `compose.yaml` sichern. Das aktuell laufende Image für einen Rollback erfassen und lokal mit einem eigenen Tag sichern.

   ```sh
   cd /opt/chartdb
   sudo cp -a -- compose.yaml "compose.yaml.backup-$(date +%Y%m%d-%H%M%S)"
   sudo docker inspect --format '{{.Image}}' "$(sudo docker compose ps -q chartdb)"
   ```

   Die ausgegebene Image-ID mit `sudo docker image tag <IMAGE-ID> chartdb:vor-sqlite-test` lokal sichern. Den Namen der Sicherungskopie notieren.
3. Das gewünschte Fork-Image vor dem Wechsel mit `sudo docker pull <FORK-IMAGE>` laden. Für den im direkten Deployment geprüften Stand lautet die Referenz `ghcr.io/dotstudent/chartdb@sha256:f74105615e40acda514323e73f14079dae0a4edae3daac8bc4c99799dd749349`. In `compose.yaml` nur den Wert von `image:` im Dienst `chartdb` ersetzen. Das Image und den Status danach prüfen.

   ```sh
   sudo docker compose config --images
   sudo docker compose up -d --no-deps --pull never chartdb
   sudo docker compose ps chartdb
   ```

4. Die bestehende ChartDB-Adresse im Browser öffnen und das Schema importieren. Beim Test auf der bestehenden Instanz erschienen fünf Webshop-Tabellen, vier Fremdschlüsselbeziehungen und der zusammengesetzte Primärschlüssel in `bestellpositionen`. Nach **Ansicht → Datenbankansichten → An** erschien auch `bestellwerte`.

Für den Rollback die gesicherte `compose.yaml` wiederherstellen, im Dienst `chartdb` das lokal gesicherte Image `chartdb:vor-sqlite-test` eintragen und `sudo docker compose up -d --no-deps --pull never chartdb` erneut ausführen. Anschließend den Status und die gewohnte URL prüfen.

## Fork mit Upstream abgleichen

```sh
git remote add upstream https://github.com/chartdb/chartdb.git
git fetch upstream
git checkout main
git pull --ff-only origin main
git merge --ff-only upstream/main
git push origin main
git checkout feature/sqlite-file-import
git merge main
npm ci
npm run test:ci
npm run build
git push origin feature/sqlite-file-import
```

`git remote add` ist einmalig. Wenn der Fast-Forward wegen eigener Commits auf `main` scheitert, den Upstream-Stand auf einem separaten Branch zusammenführen, testen und per Pull Request in den Fork übernehmen. Einen bereits veröffentlichten Feature-Branch per Merge aktualisieren, damit seine Historie erhalten bleibt.

## Grenzen

- Dateiobergrenze von 128 MiB. Bei WAL-Datenbanken zuerst einen konsistenten Einzeldatei-Snapshot mit der SQLite-Backup-Funktion oder `.backup` erzeugen. SQLCipher-Dateien werden nicht unterstützt.
- ChartDB übernimmt deklarierte Fremdschlüssel. Zusammengesetzte Fremdschlüssel erscheinen als Beziehung pro Spaltenpaar. SQLite-Aktionen wie `ON DELETE CASCADE` werden erkannt, ChartDB speichert sie im Diagrammmodell jedoch nicht als ausführbare Regeln. Der Import prüft keine Datenzeilen auf referenzielle Integrität.
- Reguläre spaltenbasierte Indizes und Unique Constraints werden übernommen. Ausdrucksindizes, partielle Indizes, virtuelle Tabellen, interne SQLite-Tabellen, Trigger und CHECK-Ausdrücke bleiben außen vor. Auflösbare Views erscheinen mit ihren Spalten. Ihre Definitionen und Abhängigkeiten werden nicht importiert.
- Die neuen Texte sind auf Deutsch und Englisch verfügbar. Die übrigen Sprachen verwenden die englischen Texte.
