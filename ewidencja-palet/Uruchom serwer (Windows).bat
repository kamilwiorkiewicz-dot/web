@echo off
rem Ewidencja Palet - uruchamia serwer lokalny w Windows (dwuklik).
rem Okno musi zostac otwarte, dopoki korzystasz z aplikacji. Ctrl+C albo zamkniecie okna zatrzymuje serwer.
setlocal
chcp 65001 >nul
title Ewidencja Palet - serwer
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto brak_node

node -e "process.exit(parseInt(process.versions.node,10)>=18?0:1)"
if errorlevel 1 goto stary_node

if not exist "index.html" node narzedzia\zbuduj.js
if not exist "index.html" goto koniec_blad

if not defined PORT set "PORT=8080"
node server.js --otworz
if errorlevel 1 goto koniec_blad
goto :eof

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
