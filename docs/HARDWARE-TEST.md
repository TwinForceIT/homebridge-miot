# Odbiór na rzeczywistym oczyszczaczu

Ten dokument dotyczy rzeczy, których nie potwierdzają testy automatyczne. Obecny status: **test fizycznego urządzenia i konta Xiaomi nie został wykonany**.

Zapisz wersję Homebridge, Node.js, iOS, model MIoT i wersję firmware oczyszczacza. Nie dołączaj tokenu ani pełnej konfiguracji do zgłoszenia.

1. **Logowanie:** wybierz właściwy region, wygeneruj QR, zatwierdź w Xiaomi Home. Sprawdź wygasły QR oraz anulowanie logowania. Przy dodatkowej weryfikacji konto powinno pozostać niezalogowane, a panel wyświetlić komunikat.
2. **Import:** sprawdź listę, wybierz CPA4, zapisz i uruchom ponownie Homebridge. Nieobsługiwane modele mają być widoczne bez możliwości dodania. Zakończenie sesji nie może usuwać zapisanej konfiguracji.
3. **Usługi:** w Apple Dom oczyszczacz powinien być oczyszczaczem, a nie przełącznikiem. Sprawdź powiązany czujnik powietrza oraz dostępność informacji o filtrze w szczegółach. Jeżeli dana wersja Dom ukrywa standardową charakterystykę, sprawdź ją w innym kliencie HAP.
4. **Stan początkowy:** wartości porównaj z Xiaomi Home. Wyłączone lub nieosiągalne urządzenie nie może wyświetlać wymyślonych danych.
5. **Sterowanie:** sprawdź włączenie, wyłączenie, Auto, Manual, minimalną/pośrednią/maksymalną prędkość, 0% i blokadę przycisków. Zmiana suwaka powinna wybrać Favorite i włączyć oczyszczacz.
6. **Zmiany z zewnątrz:** zmień tryb i moc w Xiaomi Home / przyciskiem. Sprawdź odświeżenie po cyklu odczytu. Sleep powinien być widoczny jako Manual, bez dodatkowego przełącznika.
7. **Filtr i powietrze:** porównaj pozostały procent filtra i PM2.5. Nie resetuj filtra dla testu. Wskazanie wymiany przy 0% jest sprawdzane automatycznie na symulatorze.
8. **Brak połączenia:** odłącz oczyszczacz od zasilania, odczekaj cykl odczytu. Dom powinien zgłaszać brak odpowiedzi, a log wskazać problem bez ujawniania tokenu. Podłącz ponownie i sprawdź powrót bez ponownego parowania.
9. **Usterki:** nie wywołuj uszkodzeń sprzętu. Jeśli urządzenie już zgłasza usterkę, porównaj jej kod z logiem. Kody silnika i czujnika, ustąpienie błędu oraz nieznane kody są pokryte symulacją.
10. **Tożsamość:** zrestartuj Homebridge i upewnij się, że pomieszczenie oraz automatyzacje pozostają. Przy imporcie ręcznego wpisu pod tym samym IP sprawdź brak duplikatu. Zmianę IP wykonuj tylko z zachowanym `id`/`did` i poprawnym nowym adresem.
11. **Praca bez chmury:** po zapisaniu konfiguracji zakończ sesję Xiaomi; sprawdź sterowanie po restarcie Homebridge bez logowania.
12. **Dłuższy przebieg:** obserwuj kilka godzin działania, reakcje na zmiany i brak restartów oczyszczacza. Zanotuj opóźnienia lub odrzucone odczyty wraz z numerem SIID/PIID i kodem, bez sekretów.

Jeśli test się nie powiedzie, do zgłoszenia wystarczą model, firmware, wersje oprogramowania, czynność odtwarzająca problem i zanonimizowany fragment logu.
