# Third-party notices

## pyhive-integration

- Package: `pyhive-integration`
- Version: `1.0.9`
- License: MIT
- Source: [Pyhive/pyhiveapi](https://github.com/Pyhive/Pyhiveapi)
- PyPI project: [pyhive-integration](https://pypi.org/project/pyhive-integration/)
- Use: isolated Hive account authentication, SMS MFA, client registration, heating discovery, polling, and commands.
- Pin: `requirements-hive.in`; deployment uses the hash-pinned `requirements-hive.lock`.

The package is an unofficial consumer-cloud adapter. Dinodia OS does not claim affiliation with Hive or British Gas. The native Hive application, installed receiver/thermostat, schedules, and physical heating fallback remain outside Dinodia OS control.

## Audit record

The `1.0.9` pin was selected for parity with the maintained Home Assistant Hive integration seam and verified from package metadata before implementation. Transitive packages are recorded with exact versions and hashes in `requirements-hive.lock`. Re-audit the package, its license, release status, and compatibility before every dependency update; do not silently replace the pin with `latest`.

On 2026-10-01, a `pip-audit` scan of the complete hash-locked Hive environment found advisories affecting transitive `urllib3==2.7.0` and `virtualenv==21.7.8`. The lock was updated to `urllib3==2.8.0` and `virtualenv==21.7.13`, using their verified wheel SHA-256 hashes. The `pyhive-integration==1.0.9` root pin was not changed. Re-run the hash-locked install check, Python adapter tests, container build, Pi package preflight, and the dependency audit before deploying this lock.
