# Publikacja @twinforce/homebridge-miot

Rejestr: **https://registry.npmjs.org**, dostęp: **publiczny**. Repozytorium pozostaje **https://github.com/TwinForceIT/homebridge-miot**. Konto npm publikującego musi mieć uprawnienia do zakresu `@twinforce`; nazwa organizacji GitHub nie przyznaje automatycznie uprawnień npm.

## Pierwsza publikacja

Pierwsze wydanie wymaga zalogowanego konta npm z prawami do `@twinforce`. Jeśli jest to organizacja npm, konto musi należeć do zespołu uprawnionego do publikacji. Sprawdź także wymagania 2FA na swoim koncie.

```sh
npm login --scope=@twinforce --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm ci
npm publish --access public
```

`prepublishOnly` uruchamia sprawdzenie typów, testy i kompilację. `prepack` zapewnia obecność gotowych plików JavaScript. Do paczki trafiają wyłącznie zadeklarowane pliki; użytkownik Homebridge nie potrzebuje TypeScript ani zależności deweloperskich. Nie można ponownie opublikować tej samej pary nazwa–wersja.

Po publikacji sprawdź dostępność:

```sh
npm view @twinforce/homebridge-miot version --registry=https://registry.npmjs.org
```

Nie wpisuj tokenów ani haseł do plików repozytorium. `.npmrc` w projekcie zawiera wyłącznie publiczne przypisanie zakresu do rejestru.

## Automatyczne kolejne wydania

Workflow `.github/workflows/publish.yml` używa npm Trusted Publishing przez OIDC, bez stałego tokenu npm w GitHub. Najpierw skonfiguruj tę relację w ustawieniach już utworzonej paczki na npmjs.com:

| Pole | Wartość |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `TwinForceIT` |
| Repository | `homebridge-miot` |
| Workflow filename | `publish.yml` |
| Environment | pozostaw puste |
| Allowed actions | zezwól na bezpośrednie `npm publish` |

Zapisanie workflow w GitHub nie konfiguruje automatycznie npm. Publikacja nie powiedzie się, dopóki powyższa relacja zaufania nie zostanie utworzona. Workflow korzysta z Node 24, npm obsługującego OIDC, runnera GitHub oraz uprawnienia `id-token: write`. Npm dołącza provenance dla publicznej paczki publikowanej z publicznego repozytorium.

Po skonfigurowaniu Trusted Publishing, w czystym repozytorium:

```sh
npm version patch
git push origin main --follow-tags
```

Tag musi dokładnie odpowiadać `v` + wersja z `package.json`. Workflow sprawdza zgodność, uruchamia testy na Node 22/24/26 i publikuje publiczną paczkę. Wersje stabilne otrzymują etykietę `latest`, wersje z przyrostkiem prerelease — `next`. Zwykły push na `main` nie publikuje paczki. Ręczne uruchomienie workflow również wymaga wybrania właściwego tagu.

Przy pierwszej publikacji lokalnej nie uruchamiaj ponownie publikacji tej samej wersji z GitHub Actions. Najpierw skonfiguruj Trusted Publishing, potem podnieś wersję dla kolejnego wydania.

## Źródła

- [Publiczne paczki scoped](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [Publikacja w zakresie organizacji npm](https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/)
- [Trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
