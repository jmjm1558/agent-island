// A persistent top-edge notch. Automatic previews never take keyboard focus;
// opening the notification center explicitly uses the Shell's modal grab.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Controls} from './controls.js';
import {Spectrum} from './spectrum.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Urgency, NotificationDestroyedReason} from 'resource:///org/gnome/shell/ui/messageTray.js';

const COLLAPSED_WIDTH = 248;
const EXPANDED_WIDTH = 480;
const MORPH_MS = 360;
const PREVIEW_MS = 2500;
const ROUTING_ROWS = 5;
const STATE_LABEL = {working: 'Trabajando', waiting: 'Te necesita', idle: 'En pausa'};
const AGENT_META = {
    'claude-code': {label: 'Claude Code', initial: 'C', icon: 'claude-code.svg'},
    'codex-desktop': {label: 'Codex · App', initial: 'X', icon: 'codex.png'},
    codex: {label: 'Codex', initial: 'X', icon: 'codex.png'},
};

export const Island = GObject.registerClass(
class Island extends PanelMenu.Button {
    _init(store, media, notifications, extensionPath, preferences) {
        super._init(0.0, 'Agent Island', true);
        this._store = store;
        this._media = media;
        this._notifications = notifications;
        this._assetsPath = GLib.build_filenamev([extensionPath, 'assets']);
        this._view = 'alerts';
        this._allApps = false;
        this._expandedGroups = new Set();
        this._expanded = false;
        this._preview = null;
        this._pending = [];
        this._grab = null;
        this._syncId = 0;
        this._previewId = 0;
        this._autoExpandId = 0;
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._settingsId = this._settings.connect('changed::show-banners', () => {
            if (!this._settings.get_boolean('show-banners')) {
                this._pending = this._pending.filter(n => n.urgency === Urgency.CRITICAL);
                if (this._preview?.urgency !== Urgency.CRITICAL)
                    this._finishPreview();
            }
            this._queueSync();
        });
        // Reserve panel space; the visible notch lives above panel theme margins.
        this.add_child(new St.Widget({width: COLLAPSED_WIDTH}));
        this.reactive = false;
        this.can_focus = false;
        this._surface = new St.BoxLayout({
            name: 'agent-island-notch', style_class: 'agent-island-surface',
            vertical: true, reactive: true, track_hover: true, can_focus: true,
            width: COLLAPSED_WIDTH, clip_to_allocation: true,
        });
        this._header = new St.Button({
            style_class: 'agent-island-header', can_focus: true,
            accessible_name: 'Abrir centro de notificaciones', x_expand: true,
        });
        this._pill = new St.BoxLayout({style_class: 'agent-island-pill', x_expand: true});
        this._header.set_child(this._pill);
        this._header.connect('clicked', () => this._expanded ? this._collapse() : this._expand());
        this._surface.add_child(this._header);
        this._body = new St.BoxLayout({vertical: true, style_class: 'agent-island-body'});
        this._surface.add_child(this._body);
        Main.layoutManager.addTopChrome(this._surface);
        this._ears = [false, true].map(right => {
            const ear = new St.DrawingArea({width: 12, height: 12});
            ear.connect('repaint', area => {
                const cr = area.get_context();
                const [w, h] = area.get_surface_size();
                cr.setSourceRGBA(0, 0, 0, 1);
                if (right) {
                    cr.moveTo(0, h); cr.lineTo(0, 0); cr.lineTo(w, 0);
                    cr.curveTo(w * 0.45, 0, 0, h * 0.45, 0, h);
                } else {
                    cr.moveTo(0, 0); cr.lineTo(w, 0); cr.lineTo(w, h);
                    cr.curveTo(w, h * 0.45, w * 0.55, 0, 0, 0);
                }
                cr.fill(); cr.$dispose();
            });
            Main.layoutManager.addTopChrome(ear, {affectsInputRegion: false});
            return ear;
        });
        this._surface.connect('notify::width', () => this._positionOverlay());
        this._surface.connect('notify::hover', () => {
            this._cancelPreviewTimer();
            if (!this._surface.hover)
                this._armPreviewTimer();
        });
        this._surface.connect('captured-event', (_, event) => this._onCapturedEvent(event));
        Main.layoutManager.connectObject('monitors-changed', () => this._render(), this);
        Main.panel.connectObject('notify::height', () => this._render(), this);
        Main.overview.connectObject('showing', () => this._collapse(), this);
        global.display.connectObject('in-fullscreen-changed', () => this._syncVisibility(), this);
        this._store.connectObject('changed', () => this._queueSync(), this);
        this._media.connectObject('changed', () => this._queueSync(), this);
        this._notifications.connectObject('changed', () => this._queueSync(), this);
        this.connect('destroy', () => this._onIslandDestroyed());
        this._spectrumBars = [];
        this._spectrum = new Spectrum(extensionPath, levels => this._updateSpectrum(levels));
        this._preferences = preferences;
        this._controls = new Controls(preferences, this);
        this._render(false);
        this._notifications.startPresentation(notification => this._present(notification));
        if (GLib.getenv('AGENT_ISLAND_AUTOEXPAND') === '1') {
            this._autoExpandId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                this._autoExpandId = 0;
                this._expand();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _queueSync() {
        // A notification update emits several properties in one main-loop turn.
        // Coalesce them and never destroy a button in its own clicked handler.
        if (!this._syncId) {
            this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._syncId = 0;
                const live = this._notifications.notifications;
                this._pending = this._pending.filter(n => live.includes(n));
                if (this._preview && !live.includes(this._preview)) {
                    this._cancelPreviewTimer();
                    this._preview = null;
                    this._nextPreview();
                }
                this._render();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _present(notification) {
        if (!this._surface || !Main.layoutManager.primaryMonitor)
            return false;
        if (this._expanded) {
            this._queueSync();
            return true;
        }
        if (this._preview === notification) {
            this._cancelPreviewTimer();
            this._queueSync();
            this._armPreviewTimer();
        } else if (!this._pending.includes(notification)) {
            if (notification.urgency === Urgency.CRITICAL)
                this._pending.unshift(notification);
            else
                this._pending.push(notification);
            if (!this._preview)
                this._nextPreview();
            else
                this._queueSync();
        }
        return true;
    }

    _nextPreview() {
        this._preview = this._pending.shift() ?? null;
        this._render();
        this._armPreviewTimer();
    }

    _armPreviewTimer() {
        if (!this._preview || this._previewId || this._surface.hover ||
            this._preview.urgency === Urgency.CRITICAL)
            return;
        this._previewId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_MS, () => {
            this._previewId = 0;
            this._finishPreview();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPreviewTimer() {
        if (this._previewId)
            GLib.source_remove(this._previewId);
        this._previewId = 0;
    }

    _finishPreview() {
        this._cancelPreviewTimer();
        const previous = this._preview;
        this._preview = null;
        if (previous?.isTransient && this._notifications.notifications.includes(previous))
            previous.destroy(NotificationDestroyedReason.EXPIRED);
        this._nextPreview();
    }

    _expand() {
        if (this._expanded)
            return;
        this._cancelPreviewTimer();
        this._preview = null;
        this._pending = [];
        this._expanded = true;
        this._render();
        this._grab = Main.pushModal(this._surface, {actionMode: Shell.ActionMode.POPUP});
        if (this._grab.get_seat_state() !== Clutter.GrabState.ALL) {
            Main.popModal(this._grab);
            this._grab = null;
            this._collapse();
            return;
        }
        this._surface.grab_key_focus();
    }

    _collapse() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._cancelPreviewTimer();
        this._expanded = false;
        this._preview = null;
        this._pending = [];
        this._render();
    }

    _onCapturedEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            this._collapse();
            return Clutter.EVENT_STOP;
        }
        if (!this._grab || (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN))
            return Clutter.EVENT_PROPAGATE;
        const target = global.stage.get_event_actor(event);
        if (target && this._surface.contains(target))
            return Clutter.EVENT_PROPAGATE;
        this._collapse();
        return Clutter.EVENT_STOP;
    }

    _render(animate = true) {
        if (!this._surface)
            return;
        if (this._controls?.menuOpen)
            return;
        this._controls?.detach();
        this._syncPill();
        this._syncVisibility();
        this._body.remove_all_transitions();
        this._body.destroy_all_children();
        this._content = null;
        const open = this._expanded || !!this._preview;
        this._surface.set_style(`border-radius: 0 0 ${open ? 24 : 12}px ${open ? 24 : 12}px;`);
        const monitor = Main.layoutManager.primaryMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = Math.min((open ? EXPANDED_WIDTH : COLLAPSED_WIDTH) * scale,
            (monitor?.width ?? 1920) - 40 * scale);
        this._header.height = Main.panel.height || 28 * scale;
        this._body.visible = open;
        if (open) {
            this._body.width = width;
            if (this._expanded)
                this._fillOverlay();
            else
                this._fillPreview();
        }
        const [, bodyHeight] = open ? this._body.get_preferred_height(width) : [0, 0];
        const height = this._header.height + bodyHeight;
        this._surface.remove_all_transitions();
        this._surface.ease({
            width, height, duration: animate ? MORPH_MS : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });
        if (open && animate) {
            this._body.opacity = 0;
            this._body.translation_y = -6 * scale;
            this._body.ease({opacity: 255, translation_y: 0, duration: 240,
                delay: 80, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._positionOverlay();
    }

    _syncPill() {
        this._spectrumBars = [];
        this._pill.destroy_all_children();
        const sessions = this._store.sessions;
        const waiting = sessions.filter(s => s.state === 'waiting').length;
        const working = sessions.filter(s => s.state === 'working').length;
        const player = this._media.player;
        const playing = player?.status === 'Playing';
        const count = this._notifications.notifications.length;
        const quiet = !this._settings.get_boolean('show-banners');
        const icon = new St.Icon({
            icon_name: this._preview ? 'preferences-system-notifications-symbolic' :
                quiet ? 'notifications-disabled-symbolic' : 'view-grid-symbolic',
            style_class: 'agent-island-status-icon', y_align: Clutter.ActorAlign.CENTER,
        });
        this._pill.add_child(icon);
        const title = this._expanded ? 'Tu centro' : this._preview ?
            this._preview.source.title : waiting ? `${waiting} te necesita${waiting > 1 ? 'n' : ''}` :
            playing ? player.trackTitle : working ? `${working} en marcha` : 'Todo en calma';
        this._pill.add_child(this._label(title, 'agent-island-pill-title'));
        if (playing && !this._preview && !this._expanded) {
            const bars = new St.BoxLayout({style_class: 'agent-island-wave', y_align: Clutter.ActorAlign.CENTER});
            this._spectrum.levels.forEach((level, i) => {
                const bar = new St.Widget({style_class: 'agent-island-wave-bar', height: 20, width: 3,
                    scale_y: 0.1 + level * 0.9,
                    y_align: Clutter.ActorAlign.CENTER});
                bar.set_pivot_point(0.5, 0.5);
                bars.add_child(bar);
                bar.set_style(`background-color: ${i < 4 ? '#b5c0ff' : i < 8 ? '#d3c6ff' : '#f0e6ff'};`);
                this._spectrumBars.push(bar);
            });
            this._pill.add_child(bars);
        } else if (working || waiting) {
            const dot = this._makeDot(waiting ? 'waiting' : 'working');
            this._pill.add_child(dot);
            this._pulse(dot, 'opacity', 255, 120, 1800);
        }
        if (count)
            this._pill.add_child(new St.Label({text: `${count}`, style_class: 'agent-island-count', y_align: Clutter.ActorAlign.CENTER}));
        if (this._expanded || this._preview)
            this._pill.add_child(new St.Icon({icon_name: this._expanded ? 'pan-up-symbolic' : 'pan-down-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER}));
        this._header.accessible_name = this._expanded ? 'Cerrar centro de notificaciones' : 'Abrir centro de notificaciones';
    }

    _updateSpectrum(levels) {
        this._spectrumBars.forEach((bar, i) => {
            const scale = 0.1 + levels[i] * 0.9;
            if (St.Settings.get().enable_animations)
                bar.ease({scale_y: scale, duration: 65, mode: Clutter.AnimationMode.LINEAR});
            else
                bar.scale_y = scale;
        });
    }

    _label(text, style, wrap = false) {
        const label = new St.Label({text: String(text ?? ''), style_class: style,
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.line_wrap = wrap;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        return label;
    }

    _makeDot(state) {
        return new St.Widget({style_class: `agent-island-dot agent-island-dot-${state}`, y_align: Clutter.ActorAlign.CENTER});
    }

    _pulse(actor, property, from, to, duration) {
        if (!St.Settings.get().enable_animations)
            return;
        const pulse = new Clutter.PropertyTransition({property_name: property, duration,
            progress_mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeat_count: -1, auto_reverse: true});
        pulse.set_from(from);
        pulse.set_to(to);
        actor.add_transition('agent-island-pulse', pulse);
    }

    _fillPreview() {
        this._body.add_child(this._makeNotificationRow(this._preview, true));
        const footer = new St.BoxLayout({style_class: 'agent-island-preview-footer'});
        const all = new St.Button({label: this._pending.length ?
            `Ver todas · ${this._pending.length} en espera` : 'Abrir centro',
        style_class: 'agent-island-text-button', can_focus: true, x_expand: true, x_align: Clutter.ActorAlign.START});
        all.connect('clicked', () => this._expand());
        footer.add_child(all);
        footer.add_child(this._iconButton('pan-up-symbolic', 'Ocultar aviso', () => this._finishPreview()));
        this._body.add_child(footer);
    }

    _fillOverlay() {
        const top = new St.BoxLayout({style_class: 'agent-island-toolbar'});
        const tabs = new St.BoxLayout({style_class: 'agent-island-tabs', x_expand: true});
        for (const [id, title] of [['alerts', 'Avisos'], ['sessions', 'Sesiones'], ['controls', 'Controles'], ['music', 'Música'], ['settings', 'Ajustes']]) {
            const count = id === 'alerts' ? this._notifications.notifications.length : this._store.sessions.length;
            const tab = new St.Button({label: ['settings', 'controls', 'music'].includes(id) ? title : `${title}  ${count}`, can_focus: true,
                style_class: 'agent-island-tab' + (this._view === id ? ' agent-island-tab-active' : '')});
            tab.connect('clicked', () => { this._view = id; this._queueSync(); });
            tabs.add_child(tab);
        }
        top.add_child(tabs);
        const quiet = !this._settings.get_boolean('show-banners');
        const dnd = this._iconButton(quiet ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic',
            quiet ? 'Desactivar No molestar' : 'Activar No molestar', () => this._settings.set_boolean('show-banners', quiet));
        if (quiet)
            dnd.add_style_class_name('agent-island-dnd-active');
        top.add_child(dnd);
        this._body.add_child(top);
        const scroll = new St.ScrollView({style_class: 'agent-island-scroll',
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: false, x_expand: true});
        this._content = new St.BoxLayout({vertical: true, style_class: 'agent-island-list', x_expand: true});
        scroll.set_child(this._content);
        this._body.add_child(scroll);
        if (this._view === 'sessions')
            this._fillSessionsView();
        else if (this._view === 'music') {
            if (this._media.player)
                this._content.add_child(this._makeMediaRow(this._media.player));
            else
                this._empty('audio-x-generic-symbolic', 'Sin reproducción', 'Tu música aparecerá aquí.');
        } else if (this._view === 'controls')
            this._fillControlsView();
        else if (this._view === 'settings')
            this._fillRoutingView();
        else
            this._fillNotificationsView();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const maxHeight = Math.min(420, ((Main.layoutManager.primaryMonitor?.height ?? 900) * 0.7) / scale - 180);
        scroll.set_style(`max-height: ${Math.max(100, maxHeight)}px;`);
        const bottom = new St.BoxLayout({style_class: 'agent-island-bottom'});
        bottom.add_child(this._label(quiet ? 'No molestar activado' : this._notifications.notifications.length ? 'Notificaciones del sistema' : 'Estás al día', 'agent-island-footer-label'));
        if (this._view === 'alerts' && this._notifications.notifications.length) {
            const clear = new St.Button({label: 'Limpiar todo', style_class: 'agent-island-text-button', can_focus: true});
            clear.connect('clicked', () => this._notifications.clear());
            bottom.add_child(clear);
        }
        this._body.add_child(bottom);
    }

    _fillControlsView() {
        const clean = this._preferences.get_boolean('clean-panel');
        const toggle = new St.Button({label: clean ? 'Barra limpia: activada' : 'Barra limpia: desactivada',
            style_class: 'agent-island-text-button', can_focus: true, x_align: Clutter.ActorAlign.END});
        toggle.connect('clicked', () => {
            this._preferences.set_boolean('clean-panel', !clean);
            this._queueSync();
        });
        if (clean)
            this._content.add_child(this._controls.actor);
        this._content.add_child(toggle);
    }

    // The app's own icon, from what GNOME resolved or from its desktop entry:
    // no bundled third-party logos.
    _appIcon(app) {
        if (app.icon)
            return Gio.Icon.new_for_string(app.icon);
        const separator = app.id.indexOf(':');
        const info = app.id.slice(0, separator) === 'app'
            ? Shell.AppSystem.get_default().lookup_app(`${app.id.slice(separator + 1)}.desktop`)?.get_app_info()
            : null;
        return info?.get_icon() ?? new Gio.ThemedIcon({name: 'application-x-executable-symbolic'});
    }

    _fillRoutingView() {
        const apps = this._notifications.applications;
        const chosen = apps.filter(app => app.configured);
        const rest = apps.filter(app => !app.configured);
        const shown = this._allApps ? rest : rest.slice(0, ROUTING_ROWS);
        const header = new St.BoxLayout({style_class: 'agent-island-route-header'});
        header.add_child(this._label('Elige dónde aparecen los avisos de cada app.', 'agent-island-row-sub', true));
        // The toggle rides with the note: at the end of a scrolling list it
        // would sit below the fold, which is exactly where it is needed.
        if (rest.length > ROUTING_ROWS) {
            const toggle = new St.Button({style_class: 'agent-island-text-button', can_focus: true,
                label: this._allApps ? 'Mostrar menos' : `Ver ${rest.length - shown.length} más`});
            toggle.connect('clicked', () => { this._allApps = !this._allApps; this._queueSync(); });
            header.add_child(toggle);
        }
        this._content.add_child(header);
        const routeRow = (title, current, change, icon) => {
            const row = new St.BoxLayout({style_class: 'agent-island-route-row'});
            row.add_child(new St.Icon({gicon: icon, fallback_icon_name: 'application-x-executable-symbolic',
                style_class: 'agent-island-route-icon', y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(this._label(title, 'agent-island-row-title'));
            for (const [route, label] of [['notch', 'Notch'], ['native', 'Normal']]) {
                const button = new St.Button({label, can_focus: true, accessible_name: `${title}: ${label}`,
                    style_class: 'agent-island-tab' + (route === current ? ' agent-island-tab-active' : '')});
                button.connect('clicked', () => change(route));
                row.add_child(button);
            }
            this._content.add_child(row);
        };
        routeRow('Apps nuevas', this._notifications.defaultRoute,
            route => { this._notifications.defaultRoute = route; }, new Gio.ThemedIcon({name: 'list-add-symbolic'}));
        for (const app of [...chosen, ...shown])
            routeRow(app.title, app.route, route => this._notifications.setRoute(app.id, route), this._appIcon(app));
        this._content.add_child(this._label('Las apps se añaden al enviar su primer aviso. No molestar se aplica a ambos destinos.', 'agent-island-row-sub', true));
    }

    _empty(icon, title, body) {
        const box = new St.BoxLayout({vertical: true, style_class: 'agent-island-empty'});
        box.add_child(new St.Icon({icon_name: icon, icon_size: 28, style_class: 'agent-island-empty-icon'}));
        box.add_child(new St.Label({text: title, style_class: 'agent-island-empty-title', x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({text: body, style_class: 'agent-island-row-sub', x_align: Clutter.ActorAlign.CENTER}));
        this._content.add_child(box);
    }

    _fillSessionsView() {
        const sessions = this._store.sessions;
        if (!sessions.length) {
            this._empty('utilities-terminal-symbolic', 'Espacio para tus ideas', 'Tus agentes aparecerán aquí cuando trabajen.');
            return;
        }
        for (const session of sessions)
            this._content.add_child(this._makeRow(session));
    }

    _fillNotificationsView() {
        const notifications = this._notifications.notifications;
        if (!notifications.length) {
            this._empty('object-select-symbolic', 'Todo en calma', 'Tus próximas notificaciones llegarán a la isla.');
            return;
        }
        const groups = this._notifications.groups;
        const ids = new Set(groups.map(g => g.id));
        for (const id of this._expandedGroups) {
            if (!ids.has(id))
                this._expandedGroups.delete(id);
        }
        for (const group of groups) {
            const box = new St.BoxLayout({vertical: true, style_class: 'agent-island-notification-group'});
            const expanded = this._expandedGroups.has(group.id);
            if (group.items.length > 1) {
                const header = new St.BoxLayout({style_class: 'agent-island-group-header'});
                header.add_child(this._label(`${group.title} · ${group.items.length}`, 'agent-island-row-title'));
                header.add_child(this._iconButton('window-close-symbolic', `Descartar avisos de ${group.title}`, () => {
                    for (const notification of group.items)
                        this._notifications.dismiss(notification);
                }));
                box.add_child(header);
            }
            for (const notification of expanded ? group.items : group.items.slice(0, 1))
                box.add_child(this._makeNotificationRow(notification));
            if (group.items.length > 1) {
                const toggle = new St.Button({label: expanded ? 'Mostrar solo el último' : `Ver ${group.items.length - 1} anteriores`,
                    accessible_name: `Agrupar ${group.title}`, style_class: 'agent-island-text-button', can_focus: true});
                toggle.connect('clicked', () => {
                    if (expanded)
                        this._expandedGroups.delete(group.id);
                    else
                        this._expandedGroups.add(group.id);
                    this._queueSync();
                });
                box.add_child(toggle);
            }
            this._content.add_child(box);
        }
    }

    _iconButton(icon, title, callback) {
        const button = new St.Button({style_class: 'agent-island-icon-button', can_focus: true,
            accessible_name: title, child: new St.Icon({icon_name: icon, icon_size: 16})});
        button.connect('clicked', callback);
        return button;
    }

    _makeNotificationRow(notification, preview = false) {
        const card = new St.BoxLayout({vertical: true,
            style_class: 'agent-island-notification' + (notification.urgency === Urgency.CRITICAL ? ' agent-island-critical' : '')});
        const top = new St.BoxLayout({style_class: 'agent-island-notif-meta'});
        top.add_child(this._label(notification.source.title, 'agent-island-app-name'));
        top.add_child(new St.Label({text: timeAgo(notification.datetime.to_unix()), style_class: 'agent-island-notif-time', y_align: Clutter.ActorAlign.CENTER}));
        top.add_child(this._iconButton('window-close-symbolic', 'Descartar notificación', () => this._notifications.dismiss(notification)));
        card.add_child(top);
        const row = new St.BoxLayout({style_class: 'agent-island-notif', x_expand: true});
        row.add_child(new St.Icon({gicon: notification.gicon ?? notification.source.icon,
            fallback_icon_name: 'dialog-information-symbolic', style_class: 'agent-island-notif-icon', y_align: Clutter.ActorAlign.START}));
        const text = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'agent-island-row-text'});
        text.add_child(this._label(notification.title, 'agent-island-notif-title'));
        const body = this._label(plainBody(notification), 'agent-island-notif-body', true);
        body.clutter_text.set_single_line_mode(false);
        body.set_style(`max-height: ${preview ? 72 : 100}px;`);
        text.add_child(body);
        row.add_child(text);
        const open = new St.Button({child: row, style_class: 'agent-island-notif-btn', x_expand: true,
            can_focus: true, accessible_name: `Abrir ${notification.source.title}: ${notification.title}`});
        open.connect('clicked', () => { this._collapse(); notification.activate(); });
        card.add_child(open);
        if (notification.actions.length) {
            const actions = new St.BoxLayout({style_class: 'agent-island-actions', x_expand: true});
            for (const action of notification.actions) {
                const button = new St.Button({child: this._label(action.label, 'agent-island-action-label'),
                    style_class: 'agent-island-action', accessible_name: action.label, can_focus: true, x_expand: true});
                button.connect('clicked', () => { this._collapse(); action.activate(); });
                actions.add_child(button);
            }
            card.add_child(actions);
        }
        return card;
    }

    // [cover art] [track title + artists]        [prev] [play/pause] [next]
    _makeMediaRow(player) {
        const row = new St.BoxLayout({style_class: 'agent-island-media'});

        // Cover art doubles as the "open the player app" button.
        const cover = new St.Button({
            style_class: 'agent-island-cover-btn',
            can_focus: true,
            accessible_name: 'Abrir reproductor',
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
        text.add_child(this._label(player.trackTitle, 'agent-island-media-title'));
        text.add_child(this._label(player.trackArtists.join(', '), 'agent-island-row-sub'));
        row.add_child(text);

        const controls = new St.BoxLayout({
            style_class: 'agent-island-media-controls',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const addControl = (iconName, sensitive, onClick) => {
            const button = new St.Button({
                style_class: 'agent-island-media-btn',
                reactive: sensitive,
                can_focus: sensitive,
                accessible_name: iconName,
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
                icon_size: 36,
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
        text.add_child(this._label(headline, 'agent-island-row-title'));
        text.add_child(this._label([project, meta.label, timeAgo(session.ts)].filter(Boolean).join(' · '), 'agent-island-row-sub'));
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
            text: session.statusLabel || STATE_LABEL[session.state],
            y_align: Clutter.ActorAlign.CENTER,
        }));
        row.add_child(chip);

        const button = new St.Button({
            style_class: 'agent-island-notif-btn',
            can_focus: true,
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
        if (session.agent === 'codex-desktop' && /^[0-9a-f-]{36}$/i.test(session.sessionId)) {
            try {
                Gio.AppInfo.launch_default_for_uri(`codex://threads/${session.sessionId}`,
                    global.create_app_launch_context(0, -1));
            } catch (error) {
                console.warn(`Agent Island: cannot open Codex task: ${error.message}`);
            }
            return;
        }
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

    _syncVisibility() {
        // A critical/feedback banner is eligible even over fullscreen apps.
        const fullscreen = Main.layoutManager.primaryMonitor?.inFullscreen;
        const visible = !fullscreen || this._expanded ||
            this._preview?.urgency === Urgency.CRITICAL || !!this._preview?.forFeedback;
        this._surface.visible = visible;
        this._spectrum?.setActive(!!visible && this._media.player?.status === 'Playing' && !this._preview && !this._expanded);
        this._ears?.forEach(ear => { ear.visible = visible; });
    }

    _positionOverlay() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._surface)
            return;
        const x = monitor.x + Math.round((monitor.width - this._surface.width) / 2);
        this._surface.set_position(x, monitor.y);
        if (this._ears) {
            this._ears[0].set_position(x - this._ears[0].width, monitor.y);
            this._ears[1].set_position(x + this._surface.width, monitor.y);
        }
    }

    _onIslandDestroyed() {
        for (const key of ['_syncId', '_previewId', '_autoExpandId']) {
            if (this[key])
                GLib.source_remove(this[key]);
            this[key] = 0;
        }
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._spectrum?.destroy();
        this._spectrumBars = [];
        this._controls?.destroy();
        this._controls = null;
        this._settings.disconnect(this._settingsId);
        this._settings = null;
        this._surface.destroy();
        this._surface = null;
        this._ears.forEach(ear => ear.destroy());
        this._pending = [];
        this._preview = null;
    }
});

function plainBody(notification) {
    const body = notification.body ?? '';
    if (!notification.useBodyMarkup)
        return body;
    try {
        const [, , text] = Pango.parse_markup(body, -1, '\0');
        return text;
    } catch {
        return body.replace(/<[^>]*>/g, '');
    }
}

function timeAgo(ts) {
    const seconds = Math.max(0, GLib.get_real_time() / 1e6 - ts);
    if (seconds < 60)
        return 'ahora';
    if (seconds < 3600)
        return `hace ${Math.floor(seconds / 60)} min`;
    return `hace ${Math.floor(seconds / 3600)} h`;
}
