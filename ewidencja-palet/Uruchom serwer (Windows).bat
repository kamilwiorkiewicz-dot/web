@echo off
rem Ewidencja Palet - uruchamia serwer lokalny w Windows (dwuklik).
rem Okno musi zostac otwarte, dopoki korzystasz z aplikacji. Ctrl+C albo zamkniecie okna zatrzymuje serwer.
setlocal
chcp 65001 >nul
title Ewidencja Palet - serwer
cd /d "%~dp0"

rem Plik uruchomiony prosto z archiwum ZIP (Windows wypakowuje wtedy do folderu tymczasowego tylko ten
rem jeden plik) albo skopiowany bez reszty folderu: brakuje plikow aplikacji.
set "BRAK="
if not exist "server.js" set "BRAK=server.js"
if not exist "runtime-lokalny.js" set "BRAK=runtime-lokalny.js"
if not exist "fonts\fonts.css" set "BRAK=fonts\fonts.css"
if not exist "index.html" if not exist "narzedzia\zbuduj.js" set "BRAK=index.html"
if defined BRAK goto brak_plikow

where node >nul 2>nul
if errorlevel 1 goto brak_node

node -e "process.exit(parseInt(process.versions.node,10)>=18?0:1)"
if errorlevel 1 goto stary_node

if not exist "index.html" node narzedzia\zbuduj.js
if not exist "index.html" goto koniec_blad

if not defined PORT set "PORT=8080"
rem Ustawienia dodatkowe (opcjonalne): usun "rem " z poczatku linii i wpisz swoja wartosc.
rem Haslo dostepu (przegladarka zapyta o nie; znak %% w hasle wpisz podwojnie):
rem set "EP_HASLO=twoje haslo"
rem Wlasna domena, np. za odwrotnym serwerem proxy (kilka nazw po przecinku):
rem set "EP_HOSTY=palety.example.pl"
node server.js --otworz
if errorlevel 1 goto koniec_blad
goto :eof

:brak_plikow
echo.
echo Brakuje plikow aplikacji obok tego pliku (nie ma: %BRAK%).
echo "%~dp0" | find /i ".zip" >nul
if not errorlevel 1 echo Ten plik zostal uruchomiony prosto z archiwum ZIP, bez jego rozpakowania.
echo.
echo Co zrobic:
echo  1. Zamknij to okno.
echo  2. Kliknij pobrane archiwum ZIP prawym przyciskiem myszy i wybierz
echo     "Wyodrebnij wszystkie..." (Extract All), potem "Wyodrebnij".
echo  3. Otworz rozpakowany folder i dopiero z niego uruchom "Uruchom serwer (Windows).bat".
goto koniec_blad

:brak_node
echo.
echo Nie znaleziono programu Node.js - jest potrzebny do uruchomienia serwera.
echo Zainstaluj go ze strony https://nodejs.org (wersja LTS), a potem uruchom ten plik jeszcze raz.
echo Po instalacji czasem potrzebny jest restart komputera.
start "" "https://nodejs.org/"
goto koniec_blad

:stary_node
echo.
echo Zainstalowany Node.js jest za stary - potrzebna jest wersja 18 lub nowsza.
echo Pobierz aktualna wersje LTS ze strony https://nodejs.org
goto koniec_blad

:koniec_blad
echo.
pause
exit /b 1
