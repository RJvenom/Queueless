
/* QUEUELESS — STAFF DASHBOARD */

const API = '/api';

let state = null;
let busy = false;

// API helper
async function request(endpoint, method = 'GET', payload) {
    const options = { method };

    if (payload !== undefined) {
        options.headers = {
            'Content-Type': 'application/json'
        };
        options.body = JSON.stringify(payload);
    }

    const response = await fetch(API + endpoint, options);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Request failed.');
    }

    return data;
}

function el(id) {
    return document.getElementById(id);
}

function setText(id, value) {
    el(id).textContent = value;
}

function message(text) {
    setText('adminMessage', text);
}

// Load dashboard information
async function loadDashboard() {
    try {
        const data = await request('/state');
        state = data;
        render();
    } catch (error) {
        message('Connection error: ' + error.message);
    }
}

// Render everything
function render() {
    if (!state) return;

    setText('adminClinic', state.clinic.name);

    setText('statWaiting', state.stats.waiting);
    setText('statServed', state.stats.servedToday);
    setText('statWait', state.stats.estimatedWait + ' min');
    setText('statAverage', state.stats.averageService + ' min');

    const status = el('queueStatus');

    status.textContent = state.paused ? '● Paused' : '● Active';
    status.classList.toggle('paused', state.paused);

    setText(
        'pauseButton',
        state.paused ? 'Resume Queue' : 'Pause Queue'
    );

    renderServices();
    renderCurrent();
    renderQueue();
    renderActivity();
}

// Populate service selectors
function renderServices() {
    const filter = el('serviceFilter');
    const walkin = el('walkinService');

    const previousFilter = filter.value;
    const previousWalkin = walkin.value;

    filter.innerHTML = '';
    walkin.innerHTML = '';

    filter.add(new Option('All services', ''));
    walkin.add(new Option('Choose service', ''));

    state.services.forEach(service => {
        filter.add(new Option(service.name, service.id));

        if (service.active) {
            walkin.add(new Option(service.name, service.id));
        }
    });

    if ([...filter.options].some(o => o.value === previousFilter)) {
        filter.value = previousFilter;
    }

    if ([...walkin.options].some(o => o.value === previousWalkin)) {
        walkin.value = previousWalkin;
    }
}

// Currently called token
function getCurrent() {
    return state.queue.find(t =>
        t.status === 'Called' || t.status === 'Serving'
    );
}

function renderCurrent() {
    const current = getCurrent();

    setText('currentToken', current ? current.token : '—');

    setText(
        'currentService',
        current ? current.service : 'No active token'
    );

    setText(
        'currentStatus',
        current ? current.status : 'Waiting'
    );

    el('callNextButton').disabled = state.paused ||
        state.queue.every(t => t.status !== 'Waiting');

    el('servedButton').disabled = !current;
    el('recallButton').disabled = !current ||
        current.status !== 'Called';
}

// Queue table
function renderQueue() {
    const tbody = el('queueTable');
    tbody.innerHTML = '';

    const filter = el('serviceFilter').value;

    const tickets = state.queue.filter(t =>
        !filter || t.serviceId === filter
    );

    if (!tickets.length) {
        const row = tbody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 5;
        cell.textContent = 'No active tickets for this service.';
        return;
    }

    tickets.forEach(ticket => {
        const row = tbody.insertRow();

        const values = [
            ticket.token,
            ticket.name,
            ticket.service,
            ticket.status
        ];

        values.forEach(value => {
            const cell = row.insertCell();
            cell.textContent = value;
        });

        const actionCell = row.insertCell();

        const button = document.createElement('button');
        button.className = 'table-action';
        button.textContent = 'Mark Missed';

        button.disabled = !['Waiting', 'Called'].includes(ticket.status);

        button.addEventListener('click', () => {
            markMissed(ticket.id, ticket.token);
        });

        actionCell.appendChild(button);
    });
}

// Recent activity
function renderActivity() {
    const container = el('activityList');
    container.innerHTML = '';

    const events = [...state.events].reverse();

    if (!events.length) {
        container.textContent = 'No recent activity.';
        return;
    }

    events.forEach(event => {
        const item = document.createElement('div');
        item.className = 'activity-item';

        const dot = document.createElement('span');
        dot.className = 'activity-dot';
        dot.textContent = '✓';

        const content = document.createElement('div');

        const description = document.createElement('p');
        description.textContent = event.text;

        const time = document.createElement('small');
        time.textContent = new Date(event.at).toLocaleString();

        content.append(description, time);
        item.append(dot, content);

        container.appendChild(item);
    });
}

// Prevent duplicate staff actions
async function performAction(endpoint, payload, successText) {
    if (busy) return;

    busy = true;

    try {
        const data = await request(endpoint, 'POST', payload);

        if (data.state) {
            state = data.state;
            render();
        } else {
            await loadDashboard();
        }

        message(successText);

    } catch (error) {
        message('Error: ' + error.message);

    } finally {
        busy = false;
    }
}

// Call next waiting customer
async function callNext() {
    if (!state || busy) return;

    const serviceId = el('serviceFilter').value;

    const ticket = state.queue.find(t =>
        t.status === 'Waiting' &&
        (!serviceId || t.serviceId === serviceId)
    );

    if (!ticket) {
        message('No waiting customers for the selected service.');
        return;
    }

    await performAction(
        '/next',
        { serviceId },
        'Next customer called.'
    );
}

// Mark current token served
async function markServed() {
    if (!state || busy) return;

    const current = getCurrent();

    if (!current) {
        message('No called token found.');
        return;
    }

    await performAction(
        '/serve',
        { id: current.id },
        current.token + ' marked served.'
    );
}

// Recall current token
async function recall() {
    if (!state || busy) return;

    const current = getCurrent();

    if (!current || current.status !== 'Called') {
        message('No called token available to recall.');
        return;
    }

    await performAction(
        '/recall',
        { id: current.id },
        'Recall recorded for ' + current.token +
        '. No SMS is sent in this prototype.'
    );
}

// Mark ticket missed
async function markMissed(id, token) {
    if (busy) return;

    if (!confirm('Mark ' + token + ' as missed?')) return;

    await performAction(
        '/missed',
        { id },
        token + ' marked missed.'
    );
}

// Pause or resume queue

async function togglePause() {
    if (!state || busy) return;

    const wasPaused = state.paused;

    await performAction(
        '/pause',
        {},
        wasPaused ? 'Queue resumed.' : 'Queue paused.'
    );
}

// Register walk-in
async function registerWalkin(event) {
    event.preventDefault();

    if (busy) return;

    const name = el('walkinName').value.trim();
    const serviceId = el('walkinService').value;

    if (!name || !serviceId) {
        setText('walkinMessage', 'Enter a name and choose a service.');
        return;
    }

    busy = true;

    try {
        const data = await request('/walkin', 'POST', {
            name,
            serviceId
        });

        state = data.state;
        render();

        setText(
            'walkinMessage',
            'Token ' + data.ticket.token + ' generated successfully!'
        );

        el('walkinForm').reset();

    } catch (error) {
        setText('walkinMessage', error.message);

    } finally {
        busy = false;
    }
}

// Start dashboard
document.addEventListener('DOMContentLoaded', () => {

    el('callNextButton').addEventListener('click', callNext);

    el('servedButton').addEventListener('click', markServed);

    el('recallButton').addEventListener('click', recall);

    el('pauseButton').addEventListener('click', togglePause);

    el('walkinForm').addEventListener('submit', registerWalkin);

    el('refreshAdmin').addEventListener('click', loadDashboard);

    el('serviceFilter').addEventListener('change', renderQueue);

    loadDashboard();

    // Update dashboard every five seconds
    setInterval(() => {
        if (!busy) loadDashboard();
    }, 5000);
});

/* ADDITIONAL ADMIN FEATURES */

// Extended API helper supporting PATCH requests
async function adminAPI(endpoint, method = 'GET', payload) {
    const options = { method };

    if (payload !== undefined) {
        options.headers = {
            'Content-Type': 'application/json'
        };
        options.body = JSON.stringify(payload);
    }

    const response = await fetch('/api' + endpoint, options);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Request failed');
    }

    return data;
}

// ANALYTICS

async function loadAnalytics() {
    try {
        const data = await adminAPI('/analytics');

        const history = data.state.tickets;
        const total = history.length;

        const completed = history.filter(
            t => t.status === 'Served'
        ).length;

        const missed = history.filter(
            t => t.status === 'Missed'
        ).length;

        setText('totalTickets', total);
        setText('totalCompleted', completed);
        setText('totalMissed', missed);

        setText(
            'completionRate',
            total ? Math.round(completed / total * 100) + '%' : '0%'
        );

        const container = el('serviceAnalytics');
        container.replaceChildren();

        const maximum = Math.max(
            1,
            ...data.byService.map(s => s.count)
        );

        data.byService.forEach(service => {
            const item = document.createElement('div');
            item.className = 'analytics-service';

            const top = document.createElement('div');
            top.className = 'analytics-service-top';

            const name = document.createElement('strong');
            name.textContent = service.name;

            const count = document.createElement('span');
            count.textContent =
                service.count + ' tickets · ' +
                service.served + ' served';

            top.append(name, count);

            const bar = document.createElement('div');
            bar.className = 'analytics-bar';

            const fill = document.createElement('div');
            fill.className = 'analytics-bar-fill';

            fill.style.width =
                (service.count / maximum * 100) + '%';

            bar.appendChild(fill);
            item.append(top, bar);
            container.appendChild(item);
        });

    } catch (error) {
        message('Analytics error: ' + error.message);
    }
}

// EXPORT REPORT


async function exportReport() {
    try {
        const response = await fetch('/api/export');

        if (!response.ok) {
            throw new Error('Unable to export report.');
        }

        const data = await response.blob();

        const url = URL.createObjectURL(data);

        const link = document.createElement('a');

        link.href = url;
        link.download = 'queueless-report.json';

        document.body.appendChild(link);
        link.click();
        link.remove();

        URL.revokeObjectURL(url);

        message('Report downloaded successfully!');

    } catch (error) {
        message('Export failed: ' + error.message);
    }
}


// CLINIC SETTINGS

function loadClinicSettings() {
    if (!state) return;

    el('settingName').value = state.clinic.name;
    el('settingAddress').value = state.clinic.address;
    el('settingHours').value = state.clinic.open;
    el('settingGrace').value = state.clinic.grace;
    el('settingNotify').value = state.clinic.notifyAhead;
}

async function saveClinicSettings(event) {
    event.preventDefault();

    const clinic = {
        name: el('settingName').value.trim(),
        address: el('settingAddress').value.trim(),
        open: el('settingHours').value.trim(),
        grace: Number(el('settingGrace').value),
        notifyAhead: Number(el('settingNotify').value)
    };

    try {
        state = await adminAPI('/settings', 'PATCH', {
            clinic
        });

        render();

        setText(
            'settingsMessage',
            'Clinic settings saved successfully!'
        );

    } catch (error) {
        setText('settingsMessage', error.message);
    }
}

// SERVICE MANAGEMENT

function loadServiceSettings() {
    if (!state) return;

    const container = el('serviceSettingsList');
    container.replaceChildren();

    state.services.forEach(service => {
        const row = document.createElement('div');
        row.className = 'service-setting';
        row.dataset.id = service.id;

        const name = document.createElement('strong');
        name.textContent = service.icon + ' ' + service.name;

        const duration = document.createElement('input');
        duration.type = 'number';
        duration.min = '1';
        duration.max = '120';
        duration.value = service.duration;
        duration.className = 'service-duration';
        duration.setAttribute(
            'aria-label',
            service.name + ' duration in minutes'
        );

        const label = document.createElement('label');

        const active = document.createElement('input');
        active.type = 'checkbox';
        active.checked = service.active;
        active.className = 'service-active';

        label.append(active, ' Active');
        row.append(name, duration, label);

        container.appendChild(row);
    });
}

async function saveServiceSettings() {
    const rows = [
        ...document.querySelectorAll('.service-setting')
    ];

    const services = rows.map(row => ({
        id: row.dataset.id,
        duration: Number(
            row.querySelector('.service-duration').value
        ),
        active: row.querySelector('.service-active').checked
    }));

    if (services.some(s =>
        !Number.isInteger(s.duration) ||
        s.duration < 1 ||
        s.duration > 120
    )) {
        setText(
            'servicesMessage',
            'Enter a duration between 1 and 120 minutes.'
        );
        return;
    }

    try {
        state = await adminAPI('/settings', 'PATCH', {
            services
        });

        render();
        loadServiceSettings();

        setText(
            'servicesMessage',
            'Service changes saved successfully!'
        );

    } catch (error) {
        setText('servicesMessage', error.message);
    }
}

// INITIALIZE ADDITIONAL FEATURES

document.addEventListener('DOMContentLoaded', async () => {

    el('refreshAnalytics').addEventListener(
        'click',
        loadAnalytics
    );

    el('exportReport').addEventListener(
        'click',
        exportReport
    );

    el('clinicSettingsForm').addEventListener(
        'submit',
        saveClinicSettings
    );

    el('saveServices').addEventListener(
        'click',
        saveServiceSettings
    );

    // Wait for initial dashboard data
    try {
        state = await adminAPI('/state');

        render();
        loadClinicSettings();
        loadServiceSettings();
        await loadAnalytics();

    } catch (error) {
        message(error.message);
    }
});
// STAFF LOGOUT
document.getElementById('staffLogoutBtn')?.addEventListener('click', async () => {
    try {
        const response = await fetch('/api/logout', {
            method: 'POST'
        });

        if (!response.ok) {
            throw new Error('Logout failed');
        }

        window.location.replace('/login.html');
    } catch (error) {
        alert('Unable to log out. Please try again.');
    }
});
