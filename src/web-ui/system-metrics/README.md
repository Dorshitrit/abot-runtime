# System monitor

The optional native `system-metrics` HOME widget reads
`GET /runtime/spark-home/system-metrics?environment=...` through the existing local
Web API. The Web host owns collection, not runtime request orchestration or the
`system-probe` model tool. Construction starts no collection. Concurrent readers
share an in-flight sample and a one-second cache; nothing persists or broadcasts
samples. CPU percentage needs two observations and resets after a 15-second gap.

- Native Windows/macOS/Linux: built-in Node CPU counters and physical memory.
  Linux uses `MemAvailable` when present; Windows uses total minus available
  physical memory. macOS uses built-in `vm_stat` (500ms timeout, bounded output)
  to count anonymous app, wired and physical compressor pages minus purgeable
  pages, excluding reclaimable file cache. If unavailable, total minus free
  remains visible with an explicit “Memory incl. cache” label. Container memory
  is also labelled as including cache; these are usage gauges, not pressure gauges.
- WSL: Linux-visible resources, explicitly labelled WSL, not Windows host usage.
- Linux containers (including Docker under WSL and systemd-marked containers):
  cgroup v1/v2 usage, CPU quotas, effective cpusets and memory limits, including
  visible ancestors. Hybrid systems resolve each controller independently.
  CPU capacity uses system CPU count and container limits, not Runtime affinity.
  Unlimited memory is bounded by Linux-visible physical memory. Inaccessible controllers
  yield unavailable values, never substitute host usage. A private cgroup
  namespace cannot reveal limits hidden above its mount.
- Linux temperature: supported CPU hwmon drivers or CPU/SoC/ACPI thermal zones.
  Host sensor exposure inside a container does not make it a container sensor.
- Windows temperature: optional built-in PowerShell/CIM ACPI thermal-zone query,
  with a 1.5-second timeout, no profile, no elevation and bounded output. This is
  a thermal zone, not a promised CPU die measurement.
- macOS temperature: unavailable without a supported sensor interface. No SMC
  helper, `sudo`, driver or third-party dependency is installed or invoked.

Temperatures cache for 30 seconds; unavailable sensors cache for five minutes.
There are no server timers. The browser polls every two seconds after completion,
with a five-second request timeout, only while a mounted card is active, visible
and in the viewport. The monitor owns its DOM, fixes its height at 280px and
changes only leaf text, attributes and bar transforms. It never invalidates
HOME, reloads its iframe, calls a model or emits geometry on sample ticks.

Tests use recorded-shaped OS fixtures for Windows, Linux, WSL and cgroups, plus
controlled clocks/DOM identity checks for lifecycle and rendering. These are not
claims of a live run on every supported OS. Choosing this optional widget during
real HOME generation is the existing model-selection path and requires a
separately authorized live model check; normal metric polling has no model path.
