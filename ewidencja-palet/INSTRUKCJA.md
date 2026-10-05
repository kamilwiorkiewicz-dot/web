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

**Najpierw rozpakuj całe archiwum** (Windows: prawy przycisk na pliku `.zip` → **Wyodrębnij wszystkie…** → **Wyodrębnij**; Mac: dwuklik na pliku `.zip`). Nie uruchamiaj plików prosto z okna archiwum — wtedy wypakowuje się tylko jeden plik i aplikacja nie zadziała.

## Sposób 1 — najprostszy: dwuklik w `index.html`

1. Otwórz `index.html` — najlepiej w **Chrome** albo **Edge** (w tych przeglądarkach wersja lokalna jest sprawdzona; Safari i Firefox powinny działać, ale nie były testowane).
2. Gotowe. Dane zapisują się w tej przeglądarce, na tym komputerze.

Dobrze wiedzieć:
- Każda przeglądarka ma swoje dane. Jeśli otworzysz plik w innej przeglądarce albo na innym komputerze, zobaczysz pustą ewidencję.
- Wyczyszczenie danych przeglądarki (historii, plików cookie i danych witryn) usuwa też ewidencję. Dlatego regularnie pobieraj kopię: **Ustawienia i kopia → Pobierz kopię (.json)**.
- Działa bez internetu.
- Kilka kart z aplikacją w tej samej przeglądarce widzi zmiany na bieżąco.

## Sposób 2 — zalecany: serwer na komputerze (dane w pliku, dostęp z telefonu)

Potrzebny jest darmowy program **Node.js** (wersja LTS) ze strony https://nodejs.org — instaluje się jak każdy inny program. Jeśli go brakuje, okno serwera to powie i otworzy tę stronę.

**Windows:**
1. Rozpakuj archiwum (patrz wyżej) i otwórz rozpakowany folder.
2. Kliknij dwukrotnie `Uruchom serwer (Windows).bat`.
3. Przy pierwszym uruchomieniu Windows może ostrzec przed plikiem pobranym z internetu:
   - niebieskie okno **„System Windows ochronił ten komputer”**: kliknij **Więcej informacji**, a potem **Uruchom mimo to**;
   - okno **„Otwieranie pliku — ostrzeżenie o zabezpieczeniach”**: kliknij **Uruchom**.
4. Przy pierwszym starcie serwera Zapora Windows Defender zapyta o program Node.js. Zaznacz **Sieci prywatne** i kliknij **Zezwalaj na dostęp**. Bez tego telefony i inne komputery nie połączą się z serwerem.

**Mac:**
1. Rozpakuj archiwum (dwuklik na pliku `.zip` w Finderze) i otwórz rozpakowany folder.
2. Kliknij dwukrotnie `Uruchom serwer (Mac).command`. Przy pierwszym uruchomieniu macOS zablokuje plik pobrany z internetu:
   1. W komunikacie kliknij **Gotowe**.
   2. Otwórz **Ustawienia systemowe → Prywatność i ochrona** i przewiń w dół. Przy komunikacie o pliku „Uruchom serwer (Mac).command” kliknij **Otwórz mimo to** i potwierdź hasłem (albo Touch ID).
   3. Uruchom plik jeszcze raz dwuklikiem. Pojawi się jeszcze jedno okno z pytaniem, czy otworzyć plik: kliknij **Otwórz mimo to** (w starszych wersjach macOS: **Otwórz**). Później już nie trzeba tego powtarzać.
3. Jeśli folder aplikacji leży w **Pobranych**, na **Biurku** albo w **Dokumentach**, macOS zapyta, czy „Terminal” może mieć dostęp do plików w tym folderze. Kliknij **Pozwól**. Po kliknięciu **Nie pozwalaj** serwer zakończy się komunikatem „brak uprawnień do zapisu w folderze danych” — naprawisz to w **Ustawienia systemowe → Prywatność i ochrona → Pliki i foldery → Terminal** albo przenosząc folder aplikacji do swojego folderu domowego.
4. Jeśli Mac pisze, że plik „nie może zostać otwarty, bo brak uprawnień” (zdarza się po rozpakowaniu niektórymi programami), otwórz Terminal, wpisz `chmod +x ` (ze spacją na końcu), przeciągnij plik do okna Terminala i naciśnij Enter.
5. Skrypt otwiera aplikację w domyślnej przeglądarce, na Macu zwykle w Safari. Wersja lokalna jest sprawdzana w Chrome i Edge — jeśli w Safari coś działa nie tak, skopiuj adres `http://localhost:8080` do Chrome.

Po uruchomieniu otworzy się okno z serwerem i przeglądarka z adresem http://localhost:8080. W oknie serwera widać też adres do wpisania na telefonie albo innym komputerze w tej samej sieci Wi-Fi (np. `http://192.168.1.20:8080`).

- Dane są w folderze `dane/` obok aplikacji: `baza.json` (ewidencja), `zalaczniki/` (logo kurierów), `kopie/` (kopie zapasowe).
- Zmiany widać od razu na wszystkich otwartych urządzeniach.
- Okno serwera musi być otwarte, dopóki korzystasz z aplikacji. Zamknięcie okna zatrzymuje serwer — dane zostają w pliku.
- Gdy serwer jest wyłączony albo komputer uśpiony, na górze aplikacji pojawia się pasek **„Brak połączenia z serwerem — zmiany nie są zapisywane”** (z pomarańczowym znacznikiem). Pasek znika sam, gdy tylko serwer znowu odpowie; strona łączy się ponownie automatycznie, także po zmianie sieci Wi-Fi i po wybudzeniu telefonu. Zmian, które próbowano zapisać, gdy pasek był widoczny, nie zapisano — wprowadź je jeszcze raz.

**Inny port** (gdy 8080 jest zajęty):
- **Windows, bez wpisywania poleceń:** kliknij `Uruchom serwer (Windows).bat` prawym przyciskiem myszy → **Edytuj** (w Windows 11: **Pokaż więcej opcji → Edytuj**). W Notatniku znajdź linię `if not defined PORT set "PORT=8080"`, zmień `8080` np. na `8090`, zapisz i zamknij. Potem uruchom plik jak zwykle.
- **Mac, bez wpisywania poleceń:** kliknij `Uruchom serwer (Mac).command` prawym przyciskiem → **Otwórz za pomocą → TextEdit**. Znajdź linię `export PORT="${PORT:-8080}"`, zmień `8080` np. na `8090`, zapisz (⌘S) i zamknij. Potem uruchom plik jak zwykle.
- **Z terminala**, w folderze aplikacji:
  - Mac: w Finderze kliknij folder aplikacji prawym przyciskiem → **Usługi → Nowy terminal w folderze** (jeśli tej opcji nie ma: otwórz Terminal, wpisz `cd ` ze spacją, przeciągnij folder do okna i naciśnij Enter). Potem wpisz `PORT=8090 node server.js`.
  - Windows: otwórz folder aplikacji w Eksploratorze, kliknij pasek adresu, wpisz `cmd` i naciśnij Enter. Potem wpisz `set PORT=8090`, a następnie `node server.js`.

Adres aplikacji zmieni się wtedy na `http://localhost:8090` (na telefonie to ten sam adres co wcześniej, tylko z `:8090` na końcu).

**Hasło dostępu** (opcjonalne, przydaje się, gdy w sieci są obce urządzenia, np. Wi-Fi dla klientów w tej samej sieci). Przeglądarka zapyta o nie przy wejściu; nazwa użytkownika może być dowolna.
- **Windows:** otwórz `Uruchom serwer (Windows).bat` do edycji jak przy zmianie portu. Znajdź linię `rem set "EP_HASLO=twoje haslo"`, usuń z jej początku `rem ` i zamiast `twoje haslo` wpisz swoje hasło (znak `%` wpisz podwójnie: `%%`). Zapisz i uruchom plik ponownie.
- **Mac / z terminala:** `EP_HASLO='twoje hasło' node server.js`.

Po 5 różnych błędnych hasłach z jednego urządzenia serwer na chwilę wstrzymuje logowanie z niego (od 30 s do 15 min). Urządzenia, które są już zalogowane, działają w tym czasie normalnie. Po zmianie hasła odśwież aplikację na każdym urządzeniu — przeglądarka zapyta o nowe hasło (do tego czasu na górze widać pasek „Serwer wymaga hasła…” z przyciskiem **Odśwież stronę**).

## Sposób 3 — Synology NAS (Container Manager, DSM 7)

Warunki:
- Pakiet **Container Manager** z **Centrum pakietów** (w DSM 7.0 i 7.1 pakiet nazywa się **Docker**). Nie każdy model NAS-a go obsługuje — zwykle nie ma go w tańszych modelach z procesorem ARM (np. seria „j” i część serii „value”). Jeśli w Centrum pakietów nie ma ani Container Managera, ani Dockera, użyj sposobu 2 na komputerze w biurze.
- Przy pierwszym uruchomieniu NAS musi mieć dostęp do internetu: pobiera wtedy podstawowy obraz (Node.js).

Instalacja:
1. W **File Station** utwórz folder, np. `docker/ewidencja-palet`.
2. Wgraj do niego archiwum ZIP z aplikacją, kliknij je prawym przyciskiem i wybierz **Wyodrębnij → Wyodrębnij tutaj**. Sprawdź, czy plik `docker-compose.yml` leży bezpośrednio w tym folderze (jeśli trafił do podfolderu, w kroku 4 wskaż ten podfolder). Archiwum możesz potem usunąć.
3. Otwórz **Container Manager → Projekt → Utwórz**.
4. Nazwa: `ewidencja-palet`; ścieżka: folder z plikiem `docker-compose.yml`; źródło: **Użyj istniejącego docker-compose.yml**.
5. Kliknij **Dalej**, a potem **Gotowe**. Kontener uruchamia się sam, także po restarcie NAS-a.
6. Wejdź na `http://ADRES-NAS:8080` z dowolnego urządzenia w sieci. ADRES-NAS to adres IP NAS-a w sieci lokalnej, np. `192.168.1.10` — znajdziesz go w DSM w **Panel sterowania → Sieć → Interfejs sieciowy**, w programie **Synology Assistant** albo na stronie https://finder.synology.com. Zamiast adresu IP często działa też nazwa NAS-a, np. `http://DiskStation:8080`.

W dzienniku kontenera (**Container Manager → Kontener → ewidencja-palet → Dziennik**) serwer nie podaje adresu IP — z wnętrza kontenera widzi tylko wewnętrzny adres Dockera, więc wypisuje wskazówkę `http://ADRES-NAS:PORT`.

Dane trafiają do podfolderu `dane/` w tym samym folderze na NAS-ie, więc przeżywają restart i aktualizację kontenera. Kontener startuje jako administrator tylko po to, żeby nadać folderowi `dane/` właściwego właściciela, a potem działa jako zwykły użytkownik.

- **Inny port:** w `docker-compose.yml` zmień linię `"8080:8080"` np. na `"8090:8080"` (zmieniasz tylko liczbę przed dwukropkiem) i zbuduj projekt ponownie. Adres to wtedy `http://ADRES-NAS:8090`.
- **Hasło** (zalecane, gdy NAS ma być dostępny spoza biura). Przeglądarka zapyta o nie przy wejściu; nazwa użytkownika może być dowolna. Wybierz jeden z dwóch sposobów:
  - **Hasło w pliku (najpewniejsze, dowolne znaki).** W folderze `dane` utwórz plik `haslo.txt` z samym hasłem w pierwszej linii (np. w Notatniku na komputerze, potem wgraj przez File Station). W `docker-compose.yml` odkomentuj linię `- EP_HASLO_PLIK=/app/dane/haslo.txt` (usuń `# ` z jej początku) i zbuduj projekt ponownie.
  - **Hasło wpisane w `docker-compose.yml`.** Odkomentuj linię `- 'EP_HASLO=…'` i wpisz hasło **między apostrofami**. Każdy znak `$` w haśle wpisz podwójnie (`$$`), apostrof też podwójnie (`''`). Przykład: hasło `Ab$12 #x` wpisujesz jako `- 'EP_HASLO=Ab$$12 #x'`. Bez apostrofów Docker po cichu obcina hasło od ` #` i zamienia `$słowo` na pusty tekst — działałoby wtedy inne hasło niż to, które znasz.

  Po 5 różnych błędnych hasłach z jednego adresu serwer na chwilę przestaje przyjmować z niego hasła: najpierw na 30 s, przy kolejnych pomyłkach dłużej, najwyżej na 15 min. Urządzenia, które są już zalogowane, działają w tym czasie normalnie. To samo złe hasło wpisane kilka razy liczy się jako jedna pomyłka.

  **Zmiana hasła:** zmień je w `haslo.txt` albo w `docker-compose.yml`, zatrzymaj projekt i uruchom go ponownie (po zmianie w `docker-compose.yml`: **Zbuduj**, potem **Uruchom**). Następnie odśwież aplikację na każdym urządzeniu i wpisz nowe hasło. Urządzenie ze starym hasłem pokazuje pasek „Serwer wymaga hasła…” z przyciskiem **Odśwież stronę** i do czasu odświeżenia nie zapisuje zmian.

  Przy dostępie z internetu używaj połączenia szyfrowanego (HTTPS), np. przez **Panel sterowania → Portal logowania → Zaawansowane → Odwrotny serwer proxy** z certyfikatem Let's Encrypt — bez HTTPS hasło idzie przez sieć jawnym tekstem. Domenę, pod którą otwierasz aplikację (np. `palety.twojanazwa.synology.me`), wpisz w `docker-compose.yml` w linii `- EP_HOSTY=…` (odkomentuj ją) — inaczej serwer odpowie „Nieznana nazwa serwera”.

  Za odwrotnym serwerem proxy wszystkie urządzenia łączą się z serwerem z adresu proxy, więc 5 pomyłek jednej osoby wstrzymałoby logowanie wszystkim (zalogowanych to nie dotyczy). Odkomentuj wtedy w `docker-compose.yml` także linię `- EP_ZAUFANE_PROXY=1` — błędne hasła będą liczone osobno dla każdego urządzenia (serwer odczyta jego adres z nagłówka, który dodaje proxy). Nie włączaj tej opcji bez proxy: każdy w sieci mógłby wtedy podawać dowolny adres i obejść blokadę.
- **Aktualizacja aplikacji** (dane zostają):
  1. **Container Manager → Projekt → ewidencja-palet → Akcja → Zatrzymaj.**
  2. Dla pewności skopiuj w File Station folder `dane` w bezpieczne miejsce.
  3. Wgraj nową wersję do tego samego folderu i rozpakuj ją z zastępowaniem istniejących plików. **Nie usuwaj folderu `dane`** — są w nim baza, logo i kopie. Jeśli zmieniałeś coś w `docker-compose.yml` (port, hasło, EP_HOSTY), przenieś te zmiany do nowego pliku.
  4. **Akcja → Zbuduj** (w niektórych wersjach DSM: **Kompiluj** albo **Build**), potem **Uruchom**. Na koniec odśwież aplikację w przeglądarkach.

## Przeniesienie danych z wersji online

1. W wersji online (Claude): **Ustawienia i kopia → Pobierz kopię (.json)**.
2. W wersji lokalnej: **Ustawienia i kopia → Wczytaj kopię z pliku** → wybierz pobrany plik.
3. Wybierz **Zastąp wszystko**. To właściwy wybór przy przenoszeniu z wersji online — także wtedy, gdy w wersji lokalnej wpisano wcześniej coś na próbę (w świeżej, pustej aplikacji ta opcja jest zaznaczona od razu).

Przy **Zastąp wszystko** przenoszą się kurierzy (z logo, kolejnością, nazwami i stanem początkowym), wszystkie operacje i numery dokumentów WZ/PZ — kolejne numery będą kontynuacją dotychczasowych. W drugą stronę działa tak samo.

**Połącz** służy do dopisania brakujących operacji, gdy pracowano w dwóch miejscach naraz. Nic nie jest wtedy usuwane: istniejący kurierzy zachowują swoje nazwy, kolory i kolejność (u kurierów, którzy nie mają stanu początkowego albo logo, zostaną one uzupełnione z pliku), a operacje z pliku, których numer dokumentu jest tu już zajęty przez inną operację, dostaną nowe numery. Okno wczytywania pokazuje te różnice przed zapisem.

## Kopie zapasowe

- **Ustawienia i kopia → Pobierz kopię (.json)** działa w każdej wersji, a pobrany plik da się wczytać w każdej wersji. To jedyna kopia z **aktualnym** stanem — pobieraj ją regularnie (np. raz w tygodniu i przed większymi zmianami) i trzymaj poza komputerem: na pendrivie, w chmurze albo na NAS-ie.
- W trybie serwera powstaje też automatycznie **kopia dzienna** w `dane/kopie/` (plik `baza-RRRR-MM-DD.json`). Powstaje najwyżej jedna na dzień: przy pierwszym uruchomieniu serwera danego dnia albo tuż przed pierwszą zmianą danego dnia. Zawiera więc stan **z początku dnia, sprzed dzisiejszych zmian**. Trzymanych jest 30 najnowszych kopii.
- Pełną, aktualną kopię z serwera pobierzesz od razu pod adresem `http://ADRES:8080/api/kopia`.
- Żeby przywrócić dane z kopii (także z `dane/kopie/`), wczytaj plik w aplikacji: **Wczytaj kopię z pliku → Zastąp wszystko**. Uwaga: dzisiejsza kopia dzienna cofa wszystkie dzisiejsze zmiany — jeśli serwer działa, najpierw pobierz aktualną kopię (`/api/kopia`), żeby mieć do czego wrócić.
- **Uszkodzony plik bazy.** Jeśli przy uruchomieniu serwer nie może odczytać `dane/baza.json` (np. po awarii dysku albo nieudanej ręcznej edycji), odkłada go jako `dane/baza.uszkodzona-DATA_GODZINA.json` i odtwarza dane z najnowszej poprawnej kopii dziennej. Aplikacja pokazuje wtedy na każdym urządzeniu jednorazowy komunikat z datą kopii i nazwą odłożonego pliku (zamykasz go przyciskiem **Rozumiem**). Operacje zapisane później tego dnia trzeba wprowadzić ponownie albo wczytać nowszą kopię pobraną z aplikacji. Plików w `dane/` nie edytuj ręcznie; jeśli musisz, najpierw zatrzymaj serwer.

## Najczęstsze problemy

- **„Brakuje plików aplikacji…” w oknie serwera.** Plik uruchomiono bez rozpakowania archiwum albo skopiowano go bez reszty folderu. Rozpakuj całe archiwum i uruchom plik z rozpakowanego folderu.
- **Okno serwera pisze, że brakuje Node.js.** Zainstaluj Node.js (LTS) z https://nodejs.org i uruchom plik ponownie.
- **„Port 8080 jest zajęty”.** Inny program (albo drugie okno serwera) używa tego portu. Zamknij poprzednie okno serwera albo uruchom z innym portem (patrz „Inny port”).
- **Telefon nie otwiera adresu.** Telefon musi być w tej samej sieci Wi-Fi co komputer (nie w sieci „dla gości”). Przy pierwszym uruchomieniu zapora Windows pyta o zgodę dla Node.js — zezwól w sieciach prywatnych. Jeśli to nie pomaga, sprawdź profil sieci: **Ustawienia → Sieć i Internet → Wi-Fi** (albo **Ethernet**) → nazwa Twojej sieci → **Typ profilu sieci: Prywatna**; gdy sieć jest „Publiczna”, Windows blokuje połączenia z telefonów. Na Macu: jeśli w **Ustawienia systemowe → Sieć → Zapora** zapora jest włączona, zezwól na połączenia przychodzące dla programu „node”.
- **Pasek „Brak połączenia z serwerem”.** Serwer nie odpowiada: jest wyłączony, komputer z serwerem jest uśpiony albo zerwało się Wi-Fi. Uruchom serwer ponownie; pasek zniknie sam, gdy tylko serwer odpowie.
- **„Nie wczytano pliku runtime-lokalny.js”.** `index.html` otwarto bez reszty plików (np. skopiowany sam). Otwórz go z rozpakowanego folderu.
- **„Nieznana nazwa serwera”.** Otwierasz aplikację pod własną domeną (odwrotny serwer proxy, DDNS). Ze względów bezpieczeństwa serwer odpowiada tylko pod adresem IP i nazwami z sieci lokalnej (np. `nas`, `nas.local`, `nas.lan`, `nas.home`, `nas.fritz.box`). Dopisz swoją domenę w zmiennej `EP_HOSTY` (kilka nazw rozdziel przecinkami): Docker — w `docker-compose.yml` odkomentuj linię `- EP_HOSTY=…`; Windows — w `Uruchom serwer (Windows).bat` usuń `rem ` z początku linii `rem set "EP_HOSTY=palety.example.pl"` i wpisz swoją domenę; Mac/Linux z terminala — `EP_HOSTY=palety.example.pl node server.js`.
- **„Za dużo błędnych haseł. Logowanie jest chwilowo wstrzymane…”.** Odczekaj podany czas (od 30 s do 15 min) i wpisz hasło ponownie. Urządzenia, które są już zalogowane, działają w tym czasie normalnie. Jeśli zdarza się to często, a aplikacja działa za odwrotnym serwerem proxy — włącz `EP_ZAUFANE_PROXY` (sposób 3, „Hasło”).
- **Pasek „Serwer wymaga hasła…” z przyciskiem „Odśwież stronę”.** Hasło na serwerze zmieniono albo przeglądarka je zapomniała. Kliknij **Odśwież stronę** i wpisz aktualne hasło. Do tego czasu zmiany nie są zapisywane — strona sama nie ponawia prób, żeby nie zablokować logowania starym hasłem.
- **Komunikat „plik bazy na serwerze był uszkodzony…”.** Zobacz „Kopie zapasowe”: serwer odtworzył dane z kopii dziennej. Sprawdź ostatnie operacje i kliknij **Rozumiem**.
- **Pusta ewidencja po otwarciu `index.html` w innej przeglądarce.** To normalne w sposobie 1 (każda przeglądarka ma swoje dane). Wczytaj kopię albo użyj sposobu 2.
