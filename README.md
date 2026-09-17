# @twinforce/homebridge-miot

Modułowa wtyczka Homebridge do urządzeń Xiaomi MIoT. Pierwsza obsługiwana rodzina to **Xiaomi Smart Air Purifier 4 Compact**: `zhimi.airp.cpa4` i `xiaomi.airp.cpa4`.

Oczyszczacz jest natywnym akcesorium HomeKit **AirPurifier**, z powiązanymi usługami **AirQualitySensor** i **FilterMaintenance**. Wtyczka nie tworzy dodatkowych przełączników. Sterowanie odbywa się lokalnie przez miIO/MIoT; chmura Xiaomi służy wyłącznie do konfiguracji.

**Status 0.1.0:** implementacja z testami automatycznymi, zweryfikowanymi specyfikacjami MIoT i działającym publicznym punktem rozpoczęcia logowania QR. Pełny przebieg logowania na rzeczywistym koncie, sterowanie fizycznym oczyszczaczem i prezentacja w aplikacji Dom wymagają jeszcze testu sprzętowego. Projekt nie jest certyfikowanym akcesorium Apple ani oficjalną integracją Xiaomi.

## Funkcje w Apple Dom

| Funkcja | Natywne odwzorowanie HomeKit |
| --- | --- |
| Włączanie i wyłączanie | `AirPurifier.Active` |
| Auto / ręczne sterowanie | `TargetAirPurifierState` — Auto / Manual |
| Aktualne działanie | `CurrentAirPurifierState` — wyłączony / bezczynny / oczyszczanie |
| Prędkość | `RotationSpeed`, 0–100%; 15 poziomów trybu Favorite |
| Blokada przycisków | `LockPhysicalControls` |
| PM2.5 | `AirQualitySensor.PM2_5Density`, µg/m³ |
| Kategoria jakości powietrza | `AirQuality` |
| Pozostała żywotność filtra | `FilterMaintenance.FilterLifeLevel`, 0–100% |
| Konieczność wymiany filtra | `FilterChangeIndication` przy 0% |
| Usterka | standardowy `StatusFault` w usłudze jakości powietrza + szczegóły w logach Homebridge |
| Utrata połączenia | błąd komunikacji HomeKit, zamiast potwierdzania nieaktualnego stanu |

Ustawienie prędkości powyżej 0 włącza urządzenie i tryb Favorite (Manual w HomeKit). 0 wyłącza oczyszczacz. Suwak jest przeliczany na 15 poziomów Xiaomi, więc odczyt może zostać zaokrąglony. W Auto prezentowany jest orientacyjny procent prędkości na podstawie obrotów silnika.

HomeKit nie ma standardowego trybu Sleep dla oczyszczacza. Sleep ustawiony w Xiaomi Home jest odczytywany jako Manual i minimalna pozycja suwaka. Zmiana suwaka wybiera Favorite. Nie dokładamy osobnego przełącznika Sleep.

HomeKit nie udostępnia tekstowej listy błędów ani `StatusFault` bezpośrednio w usłudze AirPurifier. Kod 2 (silnik), kod 3 (czujnik pyłu) oraz nieznane kody trafiają do logów tylko przy zmianie; odnotowywane są także ustąpienie awarii i powrót łączności. Przy błędzie czujnika kategoria powietrza jest nieznana, a odczyt PM2.5 zwraca błąd.

Zakres informacji wyświetlanych w aplikacji Dom zależy od jej wersji; standardowe charakterystyki filtra i usterek mogą być widoczne w szczegółach lub w innych klientach HomeKit. Nie można zagwarantować osobnego komunikatu tekstowego czy powiadomienia push Apple. Reset filtra pozostaje w Xiaomi Home / na urządzeniu: nie wystawiamy akcji, która mogłaby błędnie wyzerować jego zużycie.

Kategoria `AirQuality` jest polityką prezentacji wtyczki: progi PM2.5 to 12 / 35 / 55 / 150 µg/m³. Nie jest to skalibrowany AQI Xiaomi ani ocena zdrowotna. Nie są tworzone nieobsługiwane pomiary temperatury, wilgotności i PM10.

## Wymagania

- Homebridge **2.x**; aktualny zestaw testowany z Homebridge **2.4.0** i HAP-NodeJS **2.2.2**.
- Node.js **22.12+**, **24** lub **26**; lokalne testy wykonano na Node 22.23.1. CI obejmuje wszystkie trzy wersje główne.
- Aktualny Homebridge UI do konfiguracji przez panel (albo ręczna edycja `config.json`).
- Oczyszczacz sparowany wcześniej w Xiaomi Home i osiągalny z Homebridge przez UDP **54321**.
- Stały adres IPv4 / rezerwacja DHCP. Kontenery i VLAN-y muszą umożliwiać ruch do urządzenia.
- Internet podczas logowania i importu; po zapisaniu urządzenia wtyczka nie korzysta z chmury w trakcie sterowania.

## Instalacja z npm

Paczka [@twinforce/homebridge-miot](https://www.npmjs.com/package/@twinforce/homebridge-miot) jest dostępna publicznie w npmjs.org. Instalacja nie wymaga konta ani tokenu npm:

```sh
npm install -g @twinforce/homebridge-miot
```

Wykonaj polecenie w środowisku Node.js używanym przez Homebridge, np. w jego terminalu. Następnie uruchom ponownie Homebridge i otwórz ustawienia wtyczki **Xiaomi MIoT**. Repozytorium źródłowe pozostaje publiczne na GitHub; paczka jest publikowana w publicznym rejestrze npm.

### Migracja z wcześniejszej paczki lokalnej

Jeśli masz już zainstalowaną wersję o nazwie `homebridge-miot`, zastąp ją paczką z zakresem `@twinforce`. Zatrzymaj Homebridge, wykonaj oba polecenia, a następnie uruchom go ponownie:

```sh
npm uninstall -g homebridge-miot
npm install -g @twinforce/homebridge-miot
```

Zachowaj blok `platform: "XiaomiMiot"`, identyfikatory urządzeń i cache akcesoriów. Homebridge 2 rozpoznaje platformę po tej samej nazwie, a wtyczka zachowuje dotychczasowe UUID akcesoriów. Nie uruchamiaj obu wersji jednocześnie. Zaktualizuj również ewentualne wpisy `plugins`, `disabledPlugins` i pełne nazwy platformy odwołujące się do starej nazwy paczki.

### Instalacja lokalna

```sh
npm ci
npm run check
npm pack
npm install -g /pełna/ścieżka/twinforce-homebridge-miot-0.1.0.tgz
```

Na innym hoście skopiuj tam utworzone archiwum. W kontenerze użyj środowiska Homebridge i trwałego katalogu dodatków. Instrukcja pierwszej publikacji i kolejnych wydań: [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Konfiguracja przez chmurę

1. W ustawieniach wtyczki wybierz region używany w Xiaomi Home; dla Polski zwykle **Europa (de)**.
2. Kliknij **Zaloguj przez Xiaomi**. Zeskanuj QR w Xiaomi Home i zatwierdź logowanie. Dostępny jest także link do strony logowania Xiaomi.
3. Wtyczka pobierze listę urządzeń. Zaznacz obsługiwany oczyszczacz i wybierz **Dodaj i zapisz wybrane**.
4. Uruchom ponownie Homebridge. Oczyszczacz pojawi się na sparowanym mostku w aplikacji Dom.

Lista pokazuje także nieobsługiwane modele, ale nie pozwala ich importować. Jeśli Xiaomi nie zwraca lokalnego IP lub tokenu, skorzystaj z konfiguracji ręcznej. Ponowny import aktualizuje token i adres, zachowując nadaną nazwę, stały identyfikator i ustawienie włączenia.

Wtyczka nie zapisuje hasła, ciasteczek ani sesji konta na dysku. Sesja konfiguracyjna wygasa po 15 minutach i jest usuwana po imporcie, wylogowaniu lub zamknięciu panelu. Lokalne tokeny urządzeń są zapisane jawnie w `config.json`, tak jak inne sekrety Homebridge — uwzględnij to przy udostępnianiu konfiguracji i kopii zapasowych. Tokeny nie są wypisywane do logów ani zapisywane w cache akcesoriów.

Xiaomi może zmieniać niepubliczny mechanizm logowania i dostępność tokenów. Jeśli pojawi się dodatkowa weryfikacja konta, zakończ ją w Xiaomi Home i rozpocznij nowe logowanie. Konfiguracja ręczna pozostaje niezależna od tego mechanizmu.

## Konfiguracja ręczna

Użyj przycisku **Dodaj ręcznie lub edytuj konfigurację** albo dodaj blok do tablicy `platforms` istniejącej konfiguracji Homebridge:

```json
{
  "platform": "XiaomiMiot",
  "name": "Xiaomi MIoT",
  "pollInterval": 15,
  "devices": [
    {
      "name": "Oczyszczacz salon",
      "model": "zhimi.airp.cpa4",
      "host": "192.168.1.50",
      "token": "0123456789abcdef0123456789abcdef",
      "id": "oczyszczacz-salon",
      "enabled": true
    }
  ]
}
```

Token powyżej jest przykładowy — potrzebujesz własnego 32-znakowego tokenu LAN. Nie jest to hasło konta Xiaomi. Wybierz rzeczywisty identyfikator modelu: `zhimi.airp.cpa4` lub `xiaomi.airp.cpa4`.

- `pollInterval`: 10–300 sekund, domyślnie 15; kolejny cykl zaczyna się po zakończeniu poprzedniego.
- `id`: opcjonalny własny, stały identyfikator; ustaw go przy pierwszej konfiguracji ręcznej i zachowaj przy zmianie IP.
- `did`: identyfikator Xiaomi, uzupełniany przy imporcie. Bez `id` i `did` tożsamość HomeKit zależy od IP.
- `enabled: false`: usuwa urządzenie z mostka po restarcie, zachowując wpis w konfiguracji.

Import istniejącego ręcznie dodanego urządzenia pod tym samym adresem zachowuje jego tożsamość HomeKit. Sam brak odpowiedzi nie usuwa akcesorium. Usunięcie wpisu lub wyłączenie urządzenia w konfiguracji jest zamierzoną operacją usunięcia z HomeKit i może wpłynąć na automatyzacje.

## Architektura i rozwój

- `src/platform.ts`: cykl życia Homebridge, przywracanie i uzgadnianie akcesoriów.
- `src/config.ts`: walidacja konfiguracji i stabilna tożsamość urządzeń.
- `src/devices/registry.ts`: rejestr rodzin urządzeń i ich adapterów HomeKit.
- `src/devices/profiles.ts`: fakty protokołu dla CPA4 — adresy właściwości, zakresy, kody usterek.
- `src/devices/purifier.ts`: logika urządzenia, kolejka, odczyty i potwierdzanie zapisów.
- `src/homekit/purifier-accessory.ts`: mapowanie funkcji na standardowe usługi HAP.
- `src/miio/`: niezależny transport UDP, szyfrowanie, kontrola odpowiedzi i limity czasu.
- `src/cloud/`: tymczasowe logowanie i pobieranie urządzeń; brak zależności od platformy Homebridge.
- `homebridge-ui/`: panel konfiguracji i izolowana sesja importu.

Nową rodzinę urządzeń dodaj jako profil/kontroler i adapter HomeKit, następnie zarejestruj ją w `registry.ts` oraz zaktualizuj listę modeli w schemacie konfiguracji. Platforma i transport nie wymagają wtedy nowej logiki konkretnego urządzenia. Utrzymuj wyłącznie natywne usługi odpowiednie dla jego funkcji.

CPA4 odczytuje po jednej właściwości na żądanie ze względu na zgłaszane problemy firmware z odczytem grupowym. Odczyty i zapisy są kolejkowane; zapis jest potwierdzany przez ponowny odczyt. Odczyty mogą być ponawiane po nowym handshake. Zapis, dla którego zabrakło odpowiedzi, nie jest automatycznie powtarzany.

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Testy obejmują prawdziwe klasy HAP, symulowane urządzenie UDP, wektory kryptograficzne, awarie i odzyskiwanie połączenia, import, wygasanie sesji oraz stabilność tożsamości. Nie zastępują testu z fizycznym oczyszczaczem. Plan odbioru: [docs/HARDWARE-TEST.md](docs/HARDWARE-TEST.md).

## Źródła techniczne

- [Specyfikacja Xiaomi CPA4 v2](https://miot-spec.org/miot-spec-v2/instance?type=urn:miot-spec-v2:device:air-purifier:0000A007:xiaomi-cpa4:2)
- [Specyfikacja Zhimi CPA4 v1](https://miot-spec.org/miot-spec-v2/instance?type=urn:miot-spec-v2:device:air-purifier:0000A007:zhimi-cpa4:1)
- [Definicje standardowych usług HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS/blob/latest/src/lib/definitions/ServiceDefinitions.ts)
- [Wymagania Homebridge 2](https://github.com/homebridge/homebridge/wiki/Updating-To-Homebridge-v2.0)
- [Homebridge Plugin UI Utils](https://github.com/homebridge/plugin-ui-utils)
- [Referencyjna implementacja protokołu miIO](https://github.com/rytilahti/python-miio/blob/master/miio/protocol.py)
- [Referencja logowania QR i pobierania tokenów Xiaomi](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor)
- [Referencja API chmury i list domów](https://github.com/al-one/hass-xiaomi-miot/blob/master/custom_components/xiaomi_miot/core/xiaomi_cloud.py)
