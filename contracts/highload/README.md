# Highload Wallet v3 (vendored)

Аудированный контракт для массовых выплат TON/BLG.

* Upstream: https://github.com/ton-blockchain/highload-wallet-contract-v3
* Commit: `f5d9b592bd5ab5c9ae6ca627819929e140f6bd61` (2025-05-27)
* Audit: TonTech, 2025-04-24 (`audits/ton-blockchain_highload-wallet-contract-v3_2025-04-24.pdf` в upstream)
* Code hash: `11acad7955844090f283bf238bc1449871f783e7cc0979408d3f4859483e8525`
* License: MIT (см. `LICENSE`)

В репозитории лежат исходник `highload-wallet-v3.func`, precompiled BOC
`build/HighloadWalletV3.compiled.json` и TS-обёртка. Контракт не
перекомпилируется при обычной сборке: используется BOC с зафиксированным
хешем. Для проверки целостности:

```bash
sha256sum contracts/highload/build/HighloadWalletV3.compiled.json
```

Параметры выплат: `subwallet_id=0x10ad`, `timeout=3600`, ≤200 действий
на внешнее сообщение (лимит контракта — 254).
