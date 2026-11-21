# Połączenia z plików (konektory)

Nowe źródło dodajesz **plikiem**, bez programowania. Wrzuć plik `<nazwa>.yaml` do tego folderu, a Kalma
w kilka sekund utworzy połączenie, klucz API i konfigurację kolektora ([Vector](https://vector.dev)).
Pierwsza wiadomość pojawi się w „Nowe rodzaje wiadomości”.

Gotowe pliki do skopiowania pokazuje też UI: **Połączone systemy → Połącz → Innym protokołem**.

## 1. Z gotowego szablonu

```yaml
connector: firewalle          # krótka nazwa: małe litery, cyfry, myślniki
system: Pricing               # istniejący system z „Połączonych systemów”
name: Firewalle (syslog)
template: syslog              # folder z templates/
settings:
  mode: udp
  port: 5514                  # z zakresu COLLECTOR_PORTS (domyślnie 5514-5530)
```

Szablony: `syslog`, `socket` (linie tekstu albo JSON po TCP/UDP), `amqp` (RabbitMQ), `journald`.
Własny szablon to folder w `templates/<nazwa>/` z `template.yaml` (opis i ustawienia) i `collector.yaml`
(konfiguracja Vectora z miejscami `{{ustawienie}}`).

## 2. Z własną konfiguracją kolektora

```yaml
connector: kasy-linie
system: Payments
name: Terminale płatnicze
collector:
  sources:
    in:
      type: socket
      address: 0.0.0.0:5521
      mode: tcp
  transforms:            # opcjonalnie, np. filtr
    only_errors:
      type: filter
      inputs: [in]
      condition: 'contains(string!(.message), "ERROR")'
```

Za treść odpowiadasz Ty. Kalma pilnuje tylko granic:
- typy źródeł z listy `COLLECTOR_ALLOWED_SOURCES` (nigdy `exec` ani `file`), bez transformacji `lua`,
- porty z `COLLECTOR_PORTS`, każdy port w jednym pliku,
- bez własnych `sinks`: wysyłkę do Kalmy (adres i klucz) dokleja system.

Hasła wpisz do `collector/.env` (poza gitem) i użyj jako `${NAZWA}`.

## Zmiana, usunięcie, błąd

- Zmiana: edytuj plik. Kolektor przeładuje się sam.
- Usunięcie: usuń plik. Połączenie się wyłączy, a jego klucz przestanie działać.
- Błąd w pliku: widać go w „Połączone systemy → Pliki połączeń”. Działa poprzednia wersja.

Przykłady do skopiowania: `examples/`. Pliki w podfolderach nie są wczytywane.

## Uruchomienie kolektora

```bash
docker compose -f infra/docker-compose.yml --profile collector up -d collector
```

Test syslogu: `logger -n 127.0.0.1 -P 5514 -d "Firewall: dropped 1200 packets from 10.0.0.7"`.
Plan i uzasadnienie: `docs/connectors/implementation_plan.md`.
