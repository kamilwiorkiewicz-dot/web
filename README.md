# Kredyt samochodowy

Aplikacja webowa do monitorowania spłaty kredytu samochodowego. Działa na telefonie i komputerze, w jasnym i ciemnym motywie, także bez internetu (PWA, można ją dodać do ekranu głównego).

## Co potrafi

- **Panel**: saldo do spłaty, pasek-droga z autkiem, kamienie milowe (25/50/75%), następna rata z odliczaniem, informacja o zaległej racie, oszczędność dzięki nadpłatom, wykres salda z prognozą i pierwotnym planem (z podpowiedziami po dotknięciu), wydatki w tym miesiącu (także jako % dochodu), podział wpłat na kapitał, odsetki i nadpłaty, wpłaty miesiąc po miesiącu, plan a rzeczywistość.
- **Wpłaty**: dodawanie raty lub nadpłaty z notatką, edycja i usuwanie, historia pogrupowana po miesiącach z sumą. Przy każdej nadpłacie widać, ile odsetek oszczędza, a jeszcze przed zapisaniem: jaki da efekt.
- **Plan**: pełny harmonogram rata po racie (zapłacone, nadpłaty, następna, przyszłe), filtry, eksport do CSV (Excel).
- **Symulator**: „co jeśli nadpłacę X miesięcznie albo Y jednorazowo”, cel „chcę spłacić do…” (ile nadpłacać co miesiąc), porównanie, ile daje ta sama nadpłata teraz, za rok, za 2 i 3 lata.
- **Ustawienia**: parametry kredytu (z większą pierwszą ratą), tryb nadpłaty (skrócenie okresu lub obniżenie raty), dochód netto, import nowego harmonogramu z PDF banku, kopia zapasowa do przeniesienia danych między urządzeniami.

## Jak liczy

Startowo aplikacja ma wbudowany harmonogram z umowy (88 700 zł, 4,99%, 60 rat, pierwsza rata 1759,53 zł, kolejne 1673,47 zł). Odsetki każdej raty są brane z harmonogramu banku i skalowane do faktycznego salda, więc bez nadpłat wyniki zgadzają się z bankiem co do grosza, a po nadpłacie są dobrym przybliżeniem. Gdy bank przyśle nowy harmonogram, wklej go w Ustawieniach, a liczby znów będą dokładne.

Dane zapisują się tylko w przeglądarce. Starsza wersja aplikacji (`kredyt-auto-v2`) jest automatycznie przenoszona.

## Uruchomienie

```bash
npm start            # serwer na http://localhost:8080
npm test             # testy silnika obliczeń
npm run build:artifact   # jeden plik HTML: dist/kredyt-artifact.html
```

Bez żadnych zależności: czysty HTML, CSS i JavaScript. Po scaleniu do `main` workflow `.github/workflows/pages.yml` publikuje stronę na GitHub Pages (w ustawieniach repozytorium: Pages → Source: GitHub Actions).

Test w przeglądarce (wymaga Playwright): `node scripts/smoke.js http://localhost:8080/ <katalog-na-zrzuty>`.

## Struktura

| Plik | Rola |
| --- | --- |
| `js/data.js` | Harmonogram z umowy i domyślne parametry |
| `js/engine.js` | Obliczenia: harmonogram, wpłaty, prognoza, symulacje, import z banku, CSV |
| `js/charts.js` | Wykresy SVG z podpowiedziami |
| `js/app.js` | Interfejs, zapis danych, zdarzenia |
| `css/styles.css` | Wygląd, motywy jasny i ciemny |
| `sw.js`, `manifest.webmanifest` | Instalacja na telefonie i tryb offline |
