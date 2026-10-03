# Ewidencja Palet — wersja lokalna

To jest ta sama aplikacja co wersja online w Claude, w tej samej wersji, z tym samym wyglądem i tymi samymi funkcjami. Różnica jest jedna: dane nie są trzymane w Claude, tylko u Ciebie — w przeglądarce albo w pliku na dysku (komputer, NAS).

## Co jest w folderze

| Plik / folder | Do czego służy |
| --- | --- |
| `index.html` | Aplikacja. Otwierasz ją w przeglądarce. |
| `runtime-lokalny.js` | Zapis danych lokalnie (zamiast bazy Claude). |
| `fonts/` | Czcionki, żeby wszystko wyglądało jak online także bez internetu. |
| `server.js` | Mały serwer (Node.js) — dane w pliku, dostęp z kilku urządzeń. |
| `Uruchom serwer (Mac).command` | Uruchamia serwer na Macu (dwuklik). |
| `Uruchom serwer (Windows).bat` | Uruchamia serwer w Windows (dwuklik). |
| `uruchom.sh` | Uruchamia serwer w Linuksie / na NAS-ie z terminala. |
| `Dockerfile`, `docker-compose.yml` | Uruchomienie na Synology (Container Manager) albo w Dockerze. |
| `dane/` | Powstaje sam po pierwszym uruchomieniu serwera: baza (`baza.json`), logo kurierów i codzienne kopie. |
| `zrodlo/aplikacja.html` | Aplikacja dokładnie w wersji online (z niej powstaje `index.html`). |

## Sposób 1 — najprostszy: dwuklik w `index.html`

1. Otwórz `index.html` (Chrome, Edge, Safari albo Firefox).
2. Gotowe. Dane zapisują się w tej przeglądarce, na tym komputerze.

Dobrze wiedzieć:
- Każda przeglądarka ma swoje dane. Jeśli otworzysz plik w innej przeglądarce albo na innym komputerze, zobaczysz pustą ewidencję.
- Wyczyszczenie danych przeglądarki (historii, plików cookie i danych witryn) usuwa też ewidencję. Dlatego regularnie pobieraj kopię: **Ustawienia i kopia → Pobierz kopię (.json)**.
- Działa bez internetu.

## Sposób 2 — zalecany: serwer na komputerze (dane w pliku, dostęp z telefonu)

Potrzebny jest darmowy program **Node.js** (wersja LTS) ze strony https://nodejs.org — instaluje się jak każdy inny program.

**Mac:** dwuklik w `Uruchom serwer (Mac).command`. Przy pierwszym uruchomieniu macOS może zablokować plik z nieznanego źródła — wtedy kliknij go prawym przyciskiem → **Otwórz** → **Otwórz**.
**Windows:** dwuklik w `Uruchom serwer (Windows).bat`.

Otworzy się okno z serwerem i przeglądarka z adresem http://localhost:8080. W oknie serwera widać też adres do wpisania na telefonie albo innym komputerze w tej samej sieci Wi-Fi (np. `http://192.168.1.20:8080`).

- Dane są w folderze `dane/` obok aplikacji: `baza.json` (ewidencja), `zalaczniki/` (logo kurierów), `kopie/` (automatyczna kopia raz dziennie, ostatnie 30 dni).
- Zmiany widać od razu na wszystkich otwartych urządzeniach.
- Okno serwera musi być otwarte, dopóki korzystasz z aplikacji. Zamknięcie okna zatrzymuje serwer — dane zostają w pliku.
- Port można zmienić: `PORT=8090` (np. `PORT=8090 node server.js`).

## Sposób 3 — Synology NAS (Container Manager)

1. W **File Station** utwórz folder, np. `docker/ewidencja-palet`, i wgraj do niego całą zawartość tego folderu.
2. Otwórz **Container Manager → Projekt → Utwórz**.
3. Nazwa: `ewidencja-palet`, ścieżka: wybrany folder, źródło: **Użyj istniejącego docker-compose.yml**.
4. Kliknij **Dalej → Gotowe**. Kontener zbuduje się i uruchomi sam (także po restarcie NAS-a).
5. Wejdź na `http://ADRES-NAS:8080` z dowolnego urządzenia w sieci.

Dane trafiają do podfolderu `dane/` w tym samym folderze na NAS-ie, więc przeżywają restart i aktualizację kontenera. Jeśli NAS ma być dostępny z internetu, ustaw hasło: w `docker-compose.yml` odkomentuj linię `EP_HASLO` i wpisz swoje hasło (przeglądarka zapyta o nie przy wejściu; nazwa użytkownika może być dowolna).

## Przeniesienie danych z wersji online

1. W wersji online (Claude): **Ustawienia i kopia → Pobierz kopię (.json)**.
2. W wersji lokalnej: **Ustawienia i kopia → Wczytaj kopię z pliku** → wybierz pobrany plik.
3. Wybierz **Zastąp wszystko** (pierwsze przeniesienie) albo **Połącz** (dopisanie brakujących operacji).

Przenoszą się kurierzy (z logo, kolejnością i stanem początkowym), wszystkie operacje i numery dokumentów WZ/PZ — kolejne numery będą kontynuacją dotychczasowych. W drugą stronę działa tak samo.

## Kopie zapasowe

- **Ustawienia i kopia → Pobierz kopię (.json)** — w każdej wersji. Plik da się wczytać w każdej wersji.
- W trybie serwera dodatkowo co dzień powstaje kopia w `dane/kopie/`. Żeby przywrócić dane z takiej kopii, wczytaj ją w aplikacji przez **Wczytaj kopię z pliku → Zastąp wszystko**.
- Najbezpieczniej trzymać kopię także poza komputerem (pendrive, chmura, NAS).

## Najczęstsze problemy

- **„node: command not found” / okno od razu się zamyka** — zainstaluj Node.js z https://nodejs.org i uruchom ponownie.
- **„Port 8080 jest zajęty”** — inny program używa tego portu. Uruchom z innym portem (`PORT=8090`) albo zamknij poprzednie okno serwera.
- **Telefon nie otwiera adresu** — telefon musi być w tej samej sieci Wi-Fi co komputer. Zapora systemu może zapytać o zgodę dla Node.js — zezwól na dostęp w sieci prywatnej.
- **Czerwony pasek „Brak połączenia z serwerem”** — serwer jest wyłączony albo komputer z serwerem uśpiony. Uruchom go ponownie; strona połączy się sama.
- **Pusta ewidencja po otwarciu `index.html` w innej przeglądarce** — to normalne w sposobie 1 (każda przeglądarka ma swoje dane). Wczytaj kopię albo użyj sposobu 2.
