# Ewidencja Palet — wersja lokalna

To jest ta sama aplikacja co wersja online w Claude: ta sama wersja, ten sam wygląd i te same funkcje. Różnica jest jedna: dane nie są trzymane w Claude, tylko u Ciebie — w przeglądarce albo w pliku na dysku (komputer, NAS).

## Co jest w folderze

| Plik / folder | Do czego służy |
| --- | --- |
| `index.html` | Aplikacja. Otwierasz ją w przeglądarce. |
| `runtime-lokalny.js` | Zapis danych lokalnie (zamiast bazy Claude). |
| `fonts/` | Czcionki, żeby wszystko wyglądało jak online także bez internetu. |
| `server.js` | Mały serwer (Node.js) — dane w pliku, dostęp z kilku urządzeń naraz. |
| `Uruchom serwer (Mac).command` | Uruchamia serwer na Macu (dwuklik). |
| `Uruchom serwer (Windows).bat` | Uruchamia serwer w Windows (dwuklik). |
| `uruchom.sh` | Uruchamia serwer w Linuksie / na NAS-ie z terminala. |
| `Dockerfile`, `docker-compose.yml` | Uruchomienie na Synology (Container Manager) albo w Dockerze. |
| `dane/` | Powstaje sam po pierwszym uruchomieniu serwera: baza (`baza.json`), logo kurierów (`zalaczniki/`) i kopie (`kopie/`). |
| `zrodlo/aplikacja.html` | Aplikacja dokładnie w wersji online (z niej powstaje `index.html`). |
| `narzedzia/`, `testy/`, `package.json` | Dla programisty: budowanie `index.html` i testy. Do codziennej pracy niepotrzebne. |

## Sposób 1 — najprostszy: dwuklik w `index.html`

1. Otwórz `index.html` — najlepiej w **Chrome** albo **Edge** (w tych przeglądarkach wersja lokalna jest sprawdzona; Safari i Firefox powinny działać, ale nie były testowane).
2. Gotowe. Dane zapisują się w tej przeglądarce, na tym komputerze.

Dobrze wiedzieć:
- Każda przeglądarka ma swoje dane. Jeśli otworzysz plik w innej przeglądarce albo na innym komputerze, zobaczysz pustą ewidencję.
- Wyczyszczenie danych przeglądarki (historii, plików cookie i danych witryn) usuwa też ewidencję. Dlatego regularnie pobieraj kopię: **Ustawienia i kopia → Pobierz kopię (.json)**.
- Działa bez internetu.
- Kilka kart z aplikacją w tej samej przeglądarce widzi zmiany na bieżąco.

## Sposób 2 — zalecany: serwer na komputerze (dane w pliku, dostęp z telefonu)

Potrzebny jest darmowy program **Node.js** (wersja LTS) ze strony https://nodejs.org — instaluje się jak każdy inny program.

**Windows:** dwuklik w `Uruchom serwer (Windows).bat`.

**Mac:** dwuklik w `Uruchom serwer (Mac).command`. Przy pierwszym uruchomieniu macOS zablokuje plik pobrany z internetu:
1. Kliknij **Gotowe** w komunikacie.
2. Otwórz **Ustawienia systemowe → Prywatność i ochrona**, przewiń w dół i przy komunikacie o pliku „Uruchom serwer (Mac).command” kliknij **Otwórz mimo to**, potem potwierdź hasłem.
3. Uruchom plik jeszcze raz dwuklikiem. Później już nie trzeba tego powtarzać.

Jeśli Mac pisze, że plik „nie może zostać otwarty, bo brak uprawnień” (zdarza się po rozpakowaniu niektórymi programami), otwórz Terminal, wpisz `chmod +x ` (ze spacją na końcu), przeciągnij plik do okna Terminala i naciśnij Enter.

Po uruchomieniu otworzy się okno z serwerem i przeglądarka z adresem http://localhost:8080. W oknie serwera widać też adres do wpisania na telefonie albo innym komputerze w tej samej sieci Wi-Fi (np. `http://192.168.1.20:8080`). Jeśli Node.js nie jest zainstalowany, okno to powie i otworzy stronę nodejs.org.

- Dane są w folderze `dane/` obok aplikacji: `baza.json` (ewidencja), `zalaczniki/` (logo kurierów), `kopie/` (kopie zapasowe).
- Zmiany widać od razu na wszystkich otwartych urządzeniach.
- Okno serwera musi być otwarte, dopóki korzystasz z aplikacji. Zamknięcie okna zatrzymuje serwer — dane zostają w pliku.
- Gdy serwer jest wyłączony albo komputer uśpiony, na górze aplikacji pojawia się pasek **„Brak połączenia z serwerem — zmiany nie są zapisywane”** (z pomarańczowym znacznikiem). Po ponownym uruchomieniu serwera strona połączy się sama.

**Inny port** (gdy 8080 jest zajęty) — uruchom serwer ręcznie w oknie terminala, w folderze aplikacji:
- Mac / Linux: `PORT=8090 node server.js`
- Windows (Wiersz polecenia): najpierw `set PORT=8090`, potem `node server.js`

## Sposób 3 — Synology NAS (Container Manager, DSM 7)

1. W **File Station** utwórz folder, np. `docker/ewidencja-palet`, i wgraj do niego całą zawartość tego folderu.
2. Otwórz **Container Manager → Projekt → Utwórz**.
3. Nazwa: `ewidencja-palet`, ścieżka: wybrany folder, źródło: **Użyj istniejącego docker-compose.yml**.
4. Kliknij **Dalej → Gotowe**. Przy pierwszym uruchomieniu NAS pobiera z internetu podstawowy obraz (Node.js), więc musi mieć dostęp do sieci. Potem kontener uruchamia się sam, także po restarcie NAS-a.
5. Wejdź na `http://ADRES-NAS:8080` z dowolnego urządzenia w sieci.

Dane trafiają do podfolderu `dane/` w tym samym folderze na NAS-ie, więc przeżywają restart i aktualizację kontenera. Kontener startuje jako administrator tylko po to, żeby nadać folderowi `dane/` właściwego właściciela, a potem działa jako zwykły użytkownik.

- **Inny port:** w `docker-compose.yml` zmień linię `"8080:8080"` np. na `"8090:8080"` i zbuduj projekt ponownie.
- **Hasło:** jeśli NAS ma być dostępny spoza domu, odkomentuj w `docker-compose.yml` linię `EP_HASLO` i wpisz swoje hasło (przeglądarka zapyta o nie przy wejściu; nazwa użytkownika może być dowolna). Przy dostępie z internetu używaj połączenia szyfrowanego (HTTPS), np. przez **Panel sterowania → Portal logowania → Zaawansowane → Odwrotny serwer proxy** z certyfikatem Let's Encrypt — bez HTTPS hasło idzie przez sieć jawnym tekstem.

## Przeniesienie danych z wersji online

1. W wersji online (Claude): **Ustawienia i kopia → Pobierz kopię (.json)**.
2. W wersji lokalnej: **Ustawienia i kopia → Wczytaj kopię z pliku** → wybierz pobrany plik.
3. Wybierz **Zastąp wszystko** (pierwsze przeniesienie — w pustej aplikacji jest wybrane od razu) albo **Połącz** (dopisanie brakujących operacji).

Przenoszą się kurierzy (z logo, kolejnością, nazwami i stanem początkowym), wszystkie operacje i numery dokumentów WZ/PZ — kolejne numery będą kontynuacją dotychczasowych. W drugą stronę działa tak samo.

## Kopie zapasowe

- **Ustawienia i kopia → Pobierz kopię (.json)** — w każdej wersji. Plik da się wczytać w każdej wersji.
- W trybie serwera kopia powstaje też automatycznie w `dane/kopie/`: przy każdym uruchomieniu serwera i w każdy dzień, w którym coś zmieniono (dni bez zmian nie tworzą nowej kopii). Trzymanych jest 30 najnowszych kopii.
- Pełną kopię z serwera można też pobrać od razu pod adresem `http://ADRES:8080/api/kopia`.
- Żeby przywrócić dane z kopii (także z `dane/kopie/`), wczytaj plik w aplikacji: **Wczytaj kopię z pliku → Zastąp wszystko**.
- Najbezpieczniej trzymać kopię także poza komputerem (pendrive, chmura, NAS).

## Najczęstsze problemy

- **Okno serwera pisze, że brakuje Node.js** — zainstaluj Node.js (LTS) z https://nodejs.org i uruchom plik ponownie.
- **„Port 8080 jest zajęty”** — inny program (albo drugie okno serwera) używa tego portu. Zamknij poprzednie okno serwera albo uruchom z innym portem (patrz wyżej).
- **Telefon nie otwiera adresu** — telefon musi być w tej samej sieci Wi-Fi co komputer. Zapora systemu może zapytać o zgodę dla Node.js — zezwól na dostęp w sieci prywatnej.
- **Pasek „Brak połączenia z serwerem”** — serwer jest wyłączony albo komputer z serwerem uśpiony. Uruchom go ponownie; strona połączy się sama.
- **Pusta ewidencja po otwarciu `index.html` w innej przeglądarce** — to normalne w sposobie 1 (każda przeglądarka ma swoje dane). Wczytaj kopię albo użyj sposobu 2.
