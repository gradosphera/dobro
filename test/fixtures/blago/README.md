# BOC для sandbox-теста выплат

Собраны из `/home/ton/Github/blago-jetton` (FunC, `#pragma version >=0.4.3`)
командой:

```bash
func -PA -Wjetton-wallet.boc contracts/jetton-wallet.fc >/tmp/jw.fif && fift -s /tmp/jw.fif
func -PA -Wjetton-minter.boc contracts/jetton-minter.fc >/tmp/jm.fif && fift -s /tmp/jm.fif
```

Это локальная сборка jetton-контракта Градосферы для проверки TL-B
`transfer#0f8a7ea5` и авто-деплоя jetton-кошелька получателя. Она не
обязана совпадать по хешу с mainnet-кодом BLG.
