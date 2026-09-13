# Agent Island

*[English](README.md)*

Un notch negro en el borde superior para GNOME Shell 46, con previsualizaciones animadas y un hub de escritorio compacto.

![Notch cerrado](docs/img/notch-pill.png)

- **Avisos:** las previsualizaciones normales duran 2,5 segundos, se pausan al pasar el mouse encima, y el historial agrupa los avisos por aplicación con los originales expandibles. Reemplazan los banners nativos por previsualizaciones del notch, conservan las acciones y el descarte originales, y permiten elegir **Notch** o **Normal** por app en **Ajustes**. Las apps nuevas aparecen después de su primer aviso. GNOME sigue controlando No Molestar, urgencia y permisos de aplicación. El historial sigue el tiempo de vida de las notificaciones de GNOME; no es un archivo.
- **Sesiones:** tareas reales de Codex Desktop y agentes de terminal usados en los últimos 30 minutos, más sesiones verificadas en estado trabajando/esperando. Abrir un contexto renueva su visibilidad; el historial archivado no aparece en el notch. Las tareas de Desktop abren su URI exacta `codex://threads/<id>`. Las sesiones de terminal usan identidad de proceso y el salto exacto a terminal/tmux ya existente.
- **Controles:** los indicadores nativos del sistema y de otras extensiones se mueven a **Controles**, incluyendo una grilla compacta de iconos de apps, monitor de recursos y portapapeles cuando están instalados. Batería, Wi-Fi y sonido se quedan arriba a la derecha. **Barra limpia** restaura el arreglo original del panel. Los indicadores de grabación/compartir pantalla, accesibilidad y teclado se quedan en el panel.
- **Media:** una sección Música dedicada con carátula MPRIS, información de la pista, anterior/reproducir/siguiente y un espectro de doce bandas impulsado por el audio de reproducción real, con ataque rápido y liberación suave. Solo lee el monitor de reproducción mientras el espectro está visible, no guarda archivos de audio, y se detiene cuando el reproductor se cierra.

El notch cerrado iguala la altura del panel, sin tapar las pestañas de aplicaciones. El reloj se mueve a la izquierda. Abrir el notch toma el foco; las previsualizaciones automáticas no. Clic afuera o Escape para cerrar. Al desactivar la extensión se restauran el reloj, los controles y la presentación nativa de notificaciones.

## Capturas

| Avisos | Sesiones |
|---|---|
| ![Pestaña Avisos, notificaciones agrupadas](docs/img/notch-avisos.png) | ![Pestaña Sesiones, lista con scroll](docs/img/notch-sesiones.png) |

| Controles | Música |
|---|---|
| ![Pestaña Controles, monitor de recursos y accesos directos](docs/img/notch-controles.png) | ![Pestaña Música, controles MPRIS](docs/img/notch-musica.png) |

| Ajustes | Pill con el espectro |
|---|---|
| ![Pestaña Ajustes, ruta de notificaciones por app](docs/img/notch-ajustes.png) | ![Pill cerrado mostrando el espectro de reproducción junto al título de la pista](docs/img/notch-spectrum.png) |

## Datos de sesión

Los hooks de terminal escriben JSON de forma atómica en `$XDG_RUNTIME_DIR/agent-island/`, vigilado con `Gio.FileMonitor`. Una comprobación de proceso cada 15 segundos elimina los agentes muertos. Los archivos antiguos sin verificar quedan ocultos hasta que un evento de hook actual aporte identidad de proceso. Ver [el protocolo](docs/protocol.md).

Codex Desktop usa un proceso Python hijo propiedad de la extensión, un catálogo SQLite de tareas de solo lectura y el stream IPC local del desktop. Solo metadatos de tarea llegan al Shell. El estado activo viene de eventos en tiempo real, nunca de la fecha de modificación de archivos. El estado en vivo no disponible se etiqueta **Reciente**; una desconexión limpia los estados activos obsoletos. Los IDs de tarea duplicados entre desktop y terminal se combinan.

El IPC del desktop es una interfaz interna verificada contra la instalación de Codex Desktop 26.909. Las versiones desconocidas caen a tareas recientes en vez de adivinar actividad. Esta integración puede necesitar mantenimiento después de actualizaciones de Codex. La extensión no instala ningún servicio en segundo plano.

## Instalar en Ubuntu

Probado en Ubuntu 24.04 (GNOME Shell 46, Wayland). Python 3, `glib-compile-schemas` y el stack de audio ya vienen con el escritorio; normalmente solo hace falta instalar `git` y `jq`:

```bash
sudo apt install git jq
git clone https://github.com/jmjm1558/agent-island.git
cd agent-island
./install.sh --claude --codex   # las flags son opcionales e idempotentes
```

Las barras del espectro en la pestaña Música son opcionales y necesitan un paquete más para el FFT (`libpulse-simple.so.0` ya viene con el stack de audio de Ubuntu):

```bash
sudo apt install libfftw3-single3
```

Sin él las barras simplemente quedan planas; nada más en la extensión depende de este paquete. Para Fedora, Arch y otras distros, ver [Otras distros](#otras-distros) más abajo.

- `./install.sh` enlaza la extensión en `~/.local/share/gnome-shell/extensions/`.
- `--claude` registra los hooks en `~/.claude/settings.json` (guarda backup).
- `--codex` registra los hooks en `~/.codex/hooks.json` (guarda backup).
  Codex exige una aprobación única: ejecutar `/hooks` dentro de codex y confiar en ellos.

En **Wayland** una extensión recién instalada solo carga después de **cerrar sesión y volver a entrar**. Luego:

```bash
gnome-extensions enable agent-island@jmjm1558.github.io
```

### Desinstalar

```bash
gnome-extensions disable agent-island@jmjm1558.github.io
rm ~/.local/share/gnome-shell/extensions/agent-island@jmjm1558.github.io
```

Después eliminar las entradas de `agent-island-hook.sh` de `~/.claude/settings.json`
y `~/.codex/hooks.json` (o restaurar los backups `.bak` que dejó el instalador).

## Otras distros

Nada aquí depende de Ubuntu: la extensión es GJS plano contra la API estándar
de GNOME Shell, los hooks son shell POSIX más `jq`, y los dos ayudantes en
Python usan solo la librería estándar más dos librerías en tiempo de
ejecución cargadas con `ctypes`. `jq`, `python3`, `glib-compile-schemas` y
`gnome-extensions` vienen con el grupo de escritorio GNOME de cualquier
distro, e `install.sh` no pide sudo y solo toca `$HOME`. Dos cosas no viajan
solas:

- **La versión de GNOME Shell.** `extension/metadata.json` declara
  `"shell-version": ["46"]`; Shell se niega a cargar una extensión fuera de
  su versión mayor declarada. Fedora 40 y openSUSE Tumbleweed traen 46 igual
  que Ubuntu 24.04, pero una distro rolling que ya avanzó más allá necesita
  agregar su versión a ese arreglo — y los internos de panel/notificaciones
  que esta extensión toca (`Main.panel.statusArea`,
  `Main.layoutManager.addTopChrome`, los banners del message tray) ya han
  cambiado lo suficiente entre versiones de Shell antes como para que agregar
  el número de versión solo logre que cargue, no que siga comportándose igual.
- **Las dos librerías `ctypes` del espectro.** `libpulse.so.0` /
  `libpulse-simple.so.0` vienen con cualquier instalación de PulseAudio o de
  PipeWire con el shim de pulse (es decir, prácticamente cualquier escritorio
  GNOME), pero `libfftw3f.so.3` no viene preinstalada en ninguna distro y
  necesita un paquete explícito: `libfftw3-single3` en Debian/Ubuntu,
  `fftw-libs-single` en Fedora, `fftw` en Arch (trae todas las precisiones en
  un solo paquete). Si falta cualquiera de las dos, el espectro simplemente
  se queda plano; nada más en la extensión depende de ellas.

Dos cosas son intencionalmente no portables, en cualquier distro: el bridge
de Codex (`codex_bridge.py`) lee un esquema SQLite y una versión de protocolo
IPC específicos de Codex Desktop (`STREAM_VERSION = 11`, fijada a Codex
Desktop 26.909) y cae a "Reciente" ante cualquier otra versión en vez de
adivinar actividad; y `extension/spectrum.js` lanza su ayudante en la ruta
literal `/usr/bin/python3`, ausente en instalaciones no-FHS (por ejemplo
NixOS) aunque `python3` sí resuelva bien en el `$PATH`.

## Desarrollo y verificación

```bash
python3 dev/run-tests.py
python3 dev/test-codex-bridge.py
python3 dev/test-controls.py
python3 dev/test-spectrum.py
python3 dev/test-layout.py
```

La suite de UI levanta un compositor GNOME desechable con su propio D-Bus, runtime, ajustes y extensiones. Ejercita clics de puntero reales y acciones D-Bus de notificaciones. Portals y ayudantes de método de entrada quedan excluidos. Capturas y logs van a `dev/artifacts/`, que está en `.gitignore`. `--interactive` mantiene ese compositor privado vivo para inspeccionarlo.

La suite de controles también carga el código instalado del monitor de recursos y el portapapeles con ajustes privados, y comprueba que los procesos sigan vivos. La suite del espectro manda audio de prueba por un sink silencioso temporal en el servidor de sonido real y verifica la respuesta del notch, el silencio y la limpieza. Elimina el sink al terminar sin cambiar el dispositivo por defecto.

La suite del bridge cubre el filtrado SQLite, snapshots y patches de IPC, estado de aprobación, protocolos no soportados y recuperación tras desconexión. Usa un servidor de fixtures local. El estado real del stream del desktop también se comprobó durante el desarrollo; la interacción final con las extensiones instaladas del usuario requiere cargar el JavaScript nuevo en su sesión de escritorio.

En Wayland, cerrar sesión y volver a entrar para cargar el JavaScript modificado de la extensión. Activar/desactivar la extensión sola no recarga los módulos importados de forma confiable.

## Estructura

- `extension/island.js`, `stylesheet.css`: notch y vistas.
- `extension/controls.js`: reubicación reversible de indicadores nativos.
- `extension/notifications.js`, `schemas/`: enrutamiento y preferencias persistidas.
- `extension/sessions.js`, `codex_bridge.py`: procesos de terminal verificados y tareas de desktop.
- `extension/media.js`: integración MPRIS.
- `extension/spectrum.js`, `audio_spectrum.py`: FFT del monitor de reproducción y animación suave de las barras.
- `hooks/agent-island-hook.sh`: adaptador de hook compartido para terminal.
- `dev/`: pruebas aisladas de UI y del bridge.

## Licencia

GPL-2.0-or-later. Ver [LICENSE](LICENSE).
