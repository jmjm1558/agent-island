// Island - the UI side of Agent Island.
//
// Two pieces:
//   - The pill: a small rounded widget living in the center of the top bar.
//     It shows one dot per agent session, colored by state (green working,
//     amber waiting for you, gray idle). Working dots pulse.
//   - The overlay: a bigger rounded panel that drops down from the bar when
//     you click the pill, listing every session with its directory, agent
//     and state. Click the pill again, click elsewhere, or press Escape to
//     close it.
//
// The overlay is a Shell chrome actor (it belongs to the compositor scene,
// not to any window), which is what makes a real floating, always-on-top
// island possible on Wayland - ordinary apps cannot do this under GNOME
// because Mutter does not implement the wlr-layer-shell protocol.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const OVERLAY_ANIMATION_MS = 250;

// Working-dot "breathing": Apple-subtle on purpose. Long period and a
// shallow opacity dip; anything stronger reads as an alert, not a status.
const PULSE_MS = 2000;
const PULSE_MIN_OPACITY = 170;

// How each state looks. The CSS classes live in stylesheet.css.
const STATE_LABEL = {
    working: 'working',
    waiting: 'needs input',
    idle: 'idle',
};

// Display name and bundled icon per agent. Anything unknown falls back to
// its raw name and initial, so new agents work without touching this file.
const AGENT_META = {
    'claude-code': {
        label: 'Claude Code',
        initial: 'C',
        icon: 'claude-code.svg',
    },
    'codex': {
        label: 'Codex',
        initial: 'X',
        icon: 'codex.png',
    },
};

export const Island = GObject.registerClass(
class Island extends PanelMenu.Button {
    _init(store, media, notifications, extensionPath) {
        // '0.0, name, true': the `true` tells PanelMenu.Button NOT to create
        // its usual dropdown menu - we manage our own overlay instead.
        super._init(0.0, 'Agent Island', true);

        this._store = store;
        this._media = media;
        this._notifications = notifications;
        this._assetsPath =
            GLib.build_filenamev([extensionPath, 'assets']);
        this._overlay = null;
        this._grab = null;
        this._stagePressHandler = 0;
        this._view = 'sessions';   // which card view is active
        this._showIdle = false;    // idle sessions expanded in the list?

        this._pill = new St.BoxLayout({
            style_class: 'agent-island-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._pill);

        // connectObject ties the signal's lifetime to `this`: when the
        // island actor is destroyed the handlers are disconnected for us.
        this._store.connectObject('changed', () => this._sync(), this);
        this._media.connectObject('changed', () => this._sync(), this);
        this._notifications.connectObject('changed', () => this._sync(), this);
        this.connect('destroy', () => this._onIslandDestroyed());

        this._sync();

        // Dev harness: the nested-shell test script cannot click, so it
        // exports AGENT_ISLAND_AUTOEXPAND=1 to see the overlay open.
        this._autoExpandId = 0;
        if (GLib.getenv('AGENT_ISLAND_AUTOEXPAND') === '1') {
            this._autoExpandId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                this._autoExpandId = 0;
                this._expand();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // PanelMenu.Button toggles its menu on click; we have no menu, so we
    // intercept the same events to toggle the overlay.
    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.TOUCH_BEGIN)
            this._toggle();

        return Clutter.EVENT_PROPAGATE;
    }

    _toggle() {
        if (this._overlay)
            this._collapse();
        else
            this._expand();
    }

    // ---- pill ----

    _sync() {
        this._pill.destroy_all_children();

        // Something is playing: hint it in the pill, NotchNook style.
        if (this._media.player?.status === 'Playing') {
            this._pill.add_child(new St.Icon({
                style_class: 'agent-island-pill-music',
                icon_name: 'audio-x-generic-symbolic',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        // Unseen notifications: a small amber count.
        const notificationCount = this._notifications.notifications.length;
        if (notificationCount > 0) {
            this._pill.add_child(new St.Label({
                style_class: 'agent-island-pill-notif',
                text: `${notificationCount}`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const sessions = this._store.sessions;
        if (sessions.length === 0 && this._pill.get_n_children() === 0) {
            this._pill.add_child(this._makeDot('empty'));
        } else {
            for (const session of sessions.slice(0, 4)) {
                const dot = this._makeDot(session.state);
                this._pill.add_child(dot);
                if (session.state === 'working')
                    this._pulse(dot);
            }
            if (sessions.length > 4) {
                this._pill.add_child(new St.Label({
                    style_class: 'agent-island-more',
                    text: `+${sessions.length - 4}`,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
        }

        // Keep the open overlay in sync with reality.
        if (this._overlay)
            this._fillOverlay();
    }

    _makeDot(state) {
        return new St.Widget({
            style_class: `agent-island-dot agent-island-dot-${state}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    // Endless soft blink, as a single native repeating transition. Never use
    // chained ease() callbacks for this: when the actor is not yet mapped
    // (e.g. while the Shell is still starting up) ease() completes
    // synchronously and mutual callbacks become infinite recursion.
    // A transition dies with its actor, so this cannot leak either.
    _pulse(dot) {
        const pulse = new Clutter.PropertyTransition({
            property_name: 'opacity',
            duration: PULSE_MS,
            progress_mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            repeat_count: -1,
            auto_reverse: true,
        });
        pulse.set_from(255);
        pulse.set_to(PULSE_MIN_OPACITY);
        dot.add_transition('agent-island-pulse', pulse);
    }

    // ---- overlay ----

    _expand() {
        if (this._overlay)
            return;

        this._showIdle = false;
        this._overlay = new St.BoxLayout({
            style_class: 'agent-island-overlay',
            vertical: true,
            reactive: true,
            can_focus: true,
        });
        this._fillOverlay();

        // addTopChrome puts the actor in the Shell's own UI layer, above
        // all windows and unclipped by the panel.
        Main.layoutManager.addTopChrome(this._overlay);
        this._positionOverlay();

        // Drop-down animation: start folded against the bar, then unfold.
        this._overlay.set_pivot_point(0.5, 0);
        this._overlay.opacity = 0;
        this._overlay.scale_y = 0.6;
        this._overlay.ease({
            opacity: 255,
            scale_y: 1,
            duration: OVERLAY_ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._overlay.grab_key_focus();

        // Grab input like GNOME's own menus do. While the grab is held,
        // every event in the session is routed through the grabbed actor's
        // chain, so clicking anywhere - even inside an app window - can
        // dismiss the island.
        this._grab = Main.pushModal(this._overlay,
            {actionMode: Shell.ActionMode.POPUP});
        if (this._grab.get_seat_state() !== Clutter.GrabState.ALL) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        // Dismissal, straight from the Shell's GrabHelper playbook: while a
        // Clutter grab is active the STAGE never sees events (they are
        // retargeted to the grabbed actor), so listen on the overlay itself
        // and ask get_event_actor() where the click really landed.
        this._overlay.connect('captured-event', (_actor, event) => {
            const type = event.type();

            if (type === Clutter.EventType.KEY_PRESS &&
                event.get_key_symbol() === Clutter.KEY_Escape) {
                this._collapse();
                return Clutter.EVENT_STOP;
            }

            if (type !== Clutter.EventType.BUTTON_PRESS &&
                type !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;

            const target = global.stage.get_event_actor(event);
            if (this._overlay.contains(target))
                return Clutter.EVENT_PROPAGATE;

            // Menu semantics: the first click outside only dismisses.
            this._collapse();
            return Clutter.EVENT_STOP;
        });

        // Without the grab (something else holds it) outside clicks never
        // reach the overlay; at least dismiss on Shell-chrome clicks.
        if (!this._grab) {
            this._stagePressHandler = global.stage.connect('captured-event',
                (_stage, event) => {
                    const type = event.type();
                    if (type !== Clutter.EventType.BUTTON_PRESS &&
                        type !== Clutter.EventType.TOUCH_BEGIN)
                        return Clutter.EVENT_PROPAGATE;

                    const [x, y] = event.get_coords();
                    if (!this._contains(this._overlay, x, y) &&
                        !this._contains(this, x, y))
                        this._collapse();

                    return Clutter.EVENT_PROPAGATE;
                });
        }
    }

    _collapse() {
        if (!this._overlay)
            return;

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (this._stagePressHandler) {
            global.stage.disconnect(this._stagePressHandler);
            this._stagePressHandler = 0;
        }

        const overlay = this._overlay;
        this._overlay = null;
        overlay.ease({
            opacity: 0,
            scale_y: 0.6,
            duration: OVERLAY_ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => overlay.destroy(),
        });
    }

    _fillOverlay() {
        this._overlay.destroy_all_children();

        // Media first, like the macOS notch apps: art, track, controls.
        const player = this._media.player;
        if (player) {
            this._overlay.add_child(this._makeMediaRow(player));
            this._overlay.add_child(
                new St.Widget({style_class: 'agent-island-separator'}));
        }

        // One view at a time, switched with small chips (the NotchNook
        // "Nook | Tray" pattern) instead of stacking everything.
        this._overlay.add_child(this._makeViewSwitcher());
        if (this._view === 'sessions')
            this._fillSessionsView();
        else
            this._fillNotificationsView();

        // Content changed => size may have changed => re-center.
        if (this._overlay.get_parent())
            this._positionOverlay();
    }

    _makeViewSwitcher() {
        const tabs = new St.BoxLayout({style_class: 'agent-island-tabs'});

        const addTab = (id, label) => {
            const active = this._view === id;
            const tab = new St.Button({
                style_class: active
                    ? 'agent-island-tab agent-island-tab-active'
                    : 'agent-island-tab',
                label,
            });
            tab.connect('clicked', () => {
                this._view = id;
                this._fillOverlay();
            });
            tabs.add_child(tab);
        };

        const sessions = this._store.sessions.length;
        const alerts = this._notifications.notifications.length;
        addTab('sessions', sessions > 0 ? `Sessions ${sessions}` : 'Sessions');
        addTab('alerts', alerts > 0 ? `Alerts ${alerts}` : 'Alerts');

        return tabs;
    }

    _fillSessionsView() {
        const sessions = this._store.sessions;
        if (sessions.length === 0) {
            this._overlay.add_child(new St.Label({
                style_class: 'agent-island-row-sub',
                text: 'No active agent sessions',
            }));
            return;
        }

        // Busy sessions always show. Idle ones stay folded behind one quiet
        // line; when nothing is busy we show the 3 freshest so the card is
        // not empty, but it NEVER grows into a floor-length list again.
        const busy = sessions.filter(s => s.state !== 'idle');
        const idle = sessions.filter(s => s.state === 'idle');

        for (const session of busy)
            this._overlay.add_child(this._makeRow(session));

        const visibleIdle = this._showIdle
            ? idle
            : (busy.length === 0 ? idle.slice(0, 3) : []);
        for (const session of visibleIdle)
            this._overlay.add_child(this._makeRow(session));

        const hidden = idle.length - visibleIdle.length;
        if (hidden > 0) {
            const toggle = new St.Button({
                style_class: 'agent-island-idle-toggle',
                label: visibleIdle.length > 0
                    ? `${hidden} more idle`
                    : `${hidden} idle session${hidden > 1 ? 's' : ''}`,
            });
            toggle.connect('clicked', () => {
                this._showIdle = true;
                this._fillOverlay();
            });
            this._overlay.add_child(toggle);
        }
    }

    _fillNotificationsView() {
        const notifications = this._notifications.notifications;
        if (notifications.length === 0) {
            this._overlay.add_child(new St.Label({
                style_class: 'agent-island-row-sub',
                text: 'No recent notifications',
            }));
            return;
        }
        for (const notification of notifications)
            this._overlay.add_child(this._makeNotificationRow(notification));
    }

    // [app icon] [title + one line of body]                        [time]
    // Clicking a notification activates it (opens the app), same as
    // clicking it in the Shell's own notification list.
    _makeNotificationRow(notification) {
        const row = new St.BoxLayout({
            style_class: 'agent-island-notif',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });

        row.add_child(new St.Icon({
            style_class: 'agent-island-notif-icon',
            gicon: notification.gicon,
            fallback_icon_name: 'dialog-information-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const text = new St.BoxLayout({
            style_class: 'agent-island-row-text',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(new St.Label({
            style_class: 'agent-island-notif-title',
            text: notification.title ?? '',
        }));
        const body = (notification.body ?? '').split('\n')[0];
        text.add_child(new St.Label({
            style_class: 'agent-island-row-sub',
            text: body.length > 70 ? `${body.slice(0, 70)}…` : body,
        }));
        row.add_child(text);

        row.add_child(new St.Label({
            style_class: 'agent-island-notif-time',
            text: timeAgo(notification.datetime.to_unix()),
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const button = new St.Button({
            style_class: 'agent-island-notif-btn',
            child: row,
            x_expand: true,
        });
        button.connect('clicked', () => {
            this._collapse();
            notification.activate();
        });
        return button;
    }

    // [cover art] [track title + artists]        [prev] [play/pause] [next]
    _makeMediaRow(player) {
        const row = new St.BoxLayout({style_class: 'agent-island-media'});

        // Cover art doubles as the "open the player app" button.
        const cover = new St.Button({
            style_class: 'agent-island-cover-btn',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                style_class: 'agent-island-cover',
                gicon: player.trackCoverUrl
                    ? new Gio.FileIcon({
                        file: Gio.File.new_for_uri(player.trackCoverUrl),
                    })
                    : new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'}),
            }),
        });
        cover.connect('clicked', () => {
            player.raise();
            this._collapse();
        });
        row.add_child(cover);

        const text = new St.BoxLayout({
            style_class: 'agent-island-row-text',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(new St.Label({
            style_class: 'agent-island-media-title',
            text: player.trackTitle,
        }));
        text.add_child(new St.Label({
            style_class: 'agent-island-row-sub',
            text: player.trackArtists.join(', '),
        }));
        row.add_child(text);

        const controls = new St.BoxLayout({
            style_class: 'agent-island-media-controls',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const addControl = (iconName, sensitive, onClick) => {
            const button = new St.Button({
                style_class: 'agent-island-media-btn',
                reactive: sensitive,
                child: new St.Icon({
                    style_class: 'agent-island-media-btn-icon',
                    icon_name: iconName,
                }),
            });
            button.connect('clicked', onClick);
            controls.add_child(button);
        };
        addControl('media-skip-backward-symbolic',
            player.canGoPrevious, () => player.previous());
        addControl(player.status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic',
        true, () => player.playPause());
        addControl('media-skip-forward-symbolic',
            player.canGoNext, () => player.next());
        row.add_child(controls);

        return row;
    }

    // One session = one row, iPhone-island style:
    // [avatar square] [what it is doing + where]            [state chip]
    // Clicking the row focuses the window working on that directory.
    _makeRow(session) {
        const meta = AGENT_META[session.agent] ?? {
            label: session.agent,
            initial: (session.agent[0] ?? '?').toUpperCase(),
        };

        // x_expand + FILL: the wrapping St.Button centers its child by
        // default, which looks broken for short rows.
        const row = new St.BoxLayout({
            style_class: 'agent-island-row',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });

        // Known agents use bundled official artwork. The initial remains a
        // deliberate fallback for unknown agents or a missing asset.
        const iconFile = meta.icon
            ? Gio.File.new_for_path(GLib.build_filenamev([
                this._assetsPath, meta.icon,
            ]))
            : null;
        const avatarChild = iconFile?.query_exists(null)
            ? new St.Icon({
                gicon: new Gio.FileIcon({file: iconFile}),
                icon_size: 44,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            })
            : new St.Label({
                text: meta.initial,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
        const avatar = new St.Bin({
            style_class:
                `agent-island-avatar agent-island-avatar-${session.agent}`,
            y_align: Clutter.ActorAlign.CENTER,
            child: avatarChild,
        });
        row.add_child(avatar);

        const text = new St.BoxLayout({
            style_class: 'agent-island-row-text',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const project = GLib.path_get_basename(session.cwd || '');
        // Headline: what the session is doing - the last prompt if the
        // hook captured one, else the session title, else the project.
        const headline = session.task || session.title ||
            project || meta.label;
        text.add_child(new St.Label({
            style_class: 'agent-island-row-title',
            text: headline.length > 48
                ? `${headline.slice(0, 48)}…` : headline,
        }));
        text.add_child(new St.Label({
            style_class: 'agent-island-row-sub',
            text: [project, meta.label, timeAgo(session.ts)]
                .filter(part => part).join(' · '),
        }));
        row.add_child(text);

        const chip = new St.BoxLayout({
            style_class:
                `agent-island-chip agent-island-chip-${session.state}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        chip.add_child(new St.Widget({
            style_class:
                `agent-island-chip-dot agent-island-dot-${session.state}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        chip.add_child(new St.Label({
            text: STATE_LABEL[session.state],
            y_align: Clutter.ActorAlign.CENTER,
        }));
        row.add_child(chip);

        const button = new St.Button({
            style_class: 'agent-island-notif-btn',
            child: row,
            x_expand: true,
        });
        button.connect('clicked', () => {
            this._collapse();
            this._focusSessionWindow(session);
        });
        return button;
    }

    // Hook metadata identifies the terminal or tmux pane deterministically.
    // Older state files still work through the project-name title fallback.
    _focusSessionWindow(session) {
        const windows =
            global.display.get_tab_list(Meta.TabList.NORMAL, null);
        const project =
            GLib.path_get_basename(session.cwd || '').toLowerCase();
        const titleMatchesProject = window => project &&
            (window.get_title() ?? '').toLowerCase().includes(project);
        const pidMatches = session.termPid
            ? windows.filter(window => window.get_pid() === session.termPid)
            : [];
        const pidMatch =
            pidMatches.find(titleMatchesProject) ?? pidMatches[0] ?? null;
        const titleMatch = project
            ? windows.find(titleMatchesProject) ?? null
            : null;

        if (session.tmuxSocket && session.tmuxTarget) {
            if (session.tmuxClientTty) {
                this._selectTmuxTarget(session);
                const existingWindow = pidMatch ?? titleMatch;
                if (existingWindow) {
                    Main.activateWindow(existingWindow);
                    return;
                }
            }

            // aoe keeps its tmux sessions detached. Opening a terminal and
            // attaching is therefore the normal path, not an error fallback.
            if (this._attachTmuxTarget(session))
                return;
        }

        const match = pidMatch ?? titleMatch;
        if (match)
            Main.activateWindow(match);
    }

    _tmuxCommand(session) {
        const tmux = GLib.find_program_in_path('tmux');
        const separator = session.tmuxTarget.lastIndexOf(':');
        const paneSeparator = session.tmuxTarget.lastIndexOf('.');
        if (!tmux || separator <= 0 ||
            paneSeparator <= separator + 1 ||
            paneSeparator === session.tmuxTarget.length - 1)
            return null;

        return {
            argv: [
                tmux, '-S', session.tmuxSocket,
                'select-window', '-t',
                session.tmuxTarget.slice(0, paneSeparator),
                ';', 'select-pane', '-t', session.tmuxTarget,
            ],
            sessionName: session.tmuxTarget.slice(0, separator),
        };
    }

    _selectTmuxTarget(session) {
        const command = this._tmuxCommand(session);
        if (!command)
            return false;

        command.argv.push(
            ';', 'switch-client',
            '-c', session.tmuxClientTty,
            '-t', command.sessionName);
        return this._spawn(command.argv);
    }

    _attachTmuxTarget(session) {
        const command = this._tmuxCommand(session);
        if (!command)
            return false;

        command.argv.push(';', 'attach-session', '-t', command.sessionName);
        const terminalArgv = this._terminalCommand(command.argv);
        if (!terminalArgv) {
            Main.notify(
                'Agent Island',
                'No supported terminal emulator was found.');
            return false;
        }

        return this._spawn(terminalArgv);
    }

    _terminalCommand(command) {
        const launchers = [
            ['gnome-terminal', ['--']],
            ['kitty', []],
            ['konsole', ['-e']],
            ['x-terminal-emulator', ['-e']],
        ];

        for (const [program, prefix] of launchers) {
            const executable = GLib.find_program_in_path(program);
            if (executable)
                return [executable, ...prefix, ...command];
        }
        return null;
    }

    _spawn(argv) {
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            return true;
        } catch (e) {
            console.warn(
                'Agent Island: cannot run ' + argv[0] + ': ' + e.message);
            return false;
        }
    }

    // True notch: the card starts at the very top edge of the screen and
    // covers its slice of the bar (top chrome stacks above the panel), so
    // no theme margin or panel styling can leave a colored seam. Always
    // dead-centered on the monitor, like the real thing; this runs again
    // on every content change, so it stays centered as the card resizes.
    _positionOverlay() {
        const monitor = Main.layoutManager.primaryMonitor;
        const [, width] = this._overlay.get_preferred_width(-1);
        const x = monitor.x + Math.round((monitor.width - width) / 2);
        this._overlay.set_position(x, monitor.y);
    }

    // Is the stage point (x, y) inside this actor?
    _contains(actor, x, y) {
        const [ax, ay] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        return x >= ax && x <= ax + width && y >= ay && y <= ay + height;
    }

    _onIslandDestroyed() {
        if (this._autoExpandId) {
            GLib.source_remove(this._autoExpandId);
            this._autoExpandId = 0;
        }
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (this._stagePressHandler) {
            global.stage.disconnect(this._stagePressHandler);
            this._stagePressHandler = 0;
        }
        // Destroy the overlay immediately (no animation): we may be inside
        // the extension's disable() and must leave nothing behind.
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
        this._store = null;
        this._media = null;
        this._notifications = null;
    }
});

function timeAgo(ts) {
    const seconds = Math.max(0, GLib.get_real_time() / 1e6 - ts);
    if (seconds < 60)
        return 'just now';
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
}
