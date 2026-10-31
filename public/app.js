
/* QUEUELESS — CUSTOMER APPLICATION */

const API = '/api';

let selectedService = null;
let currentToken = null;
let services = [];

// API helper
async function request(endpoint, options = {}) {
    const response = await fetch(API + endpoint, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Something went wrong.');
    }

    return data;
}

// Safely display text
function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

// Load clinic and queue information
async function loadState() {
    try {
        const data = await request('/state');

        setText('clinicName', data.clinic.name);
        setText('clinicAddress', data.clinic.address);
        setText('clinicHours', data.clinic.open);

        setText('heroWaiting', data.stats.waiting);
        setText('heroServed', data.stats.servedToday);
        setText('heroWait', data.stats.estimatedWait + ' min');

        services = data.services.filter(service => service.active);

        renderServices();

    } catch (error) {
        console.error('Failed to load state:', error);
        setText('joinMessage', 'Unable to connect to the server.');
    }
}

// Display available services
function renderServices() {
    const container = document.getElementById('servicesList');

    if (!container) return;

    container.innerHTML = '';

    if (!services.length) {
        container.textContent = 'No services are currently available.';
        return;
    }

    services.forEach(service => {
        const button = document.createElement('button');

        button.type = 'button';

        button.className = 'service-option';

        if (selectedService === service.id) {
            button.classList.add('selected');
        }

        const icon = document.createElement('span');
        icon.className = 'service-icon';
        icon.textContent = service.icon;

        const name = document.createElement('span');
        name.className = 'service-name';
        name.textContent = service.name;

        const time = document.createElement('span');
        time.className = 'service-time';
        time.textContent = 'Approx. ' + service.duration + ' minutes';

        button.append(icon, name, time);

        button.addEventListener('click', () => {
            selectedService = service.id;
            renderServices();
        });

        container.appendChild(button);
    });
}

// Generate a queue token
async function joinQueue(event) {
    event.preventDefault();

    const name = document.getElementById('customerName').value.trim();
    const phone = document.getElementById('customerPhone').value.trim();

    const message = document.getElementById('joinMessage');
    const submitButton = event.target.querySelector('[type="submit"]');

    if (!selectedService) {
        message.textContent = 'Please select a service first.';
        return;
    }

    if (!name) {
        message.textContent = 'Please enter your name.';
        return;
    }

    submitButton.disabled = true;
    message.textContent = 'Generating your token...';

    try {
        const data = await request('/join', {
            method: 'POST',
            body: JSON.stringify({
                serviceId: selectedService,
                name,
                phone,
                walkIn: false
            })
        });

        currentToken = data.ticket.token;

        localStorage.setItem('queuelessToken', currentToken);

        setText('generatedToken', data.ticket.token);
        setText('generatedService', data.ticket.service);
        setText('generatedPosition', data.position);
        setText('generatedWait', data.wait + ' min');

        document.getElementById('tokenResult').hidden = false;

        document.getElementById('trackInput').value = currentToken;

        message.textContent = 'Your token was generated successfully!';

        document.getElementById('tokenResult').scrollIntoView({
            behavior: 'smooth'
        });

        event.target.reset();
        selectedService = null;
        renderServices();

        await loadState();

    } catch (error) {
        message.textContent = error.message;
    } finally {
        submitButton.disabled = false;
    }
}

// Track an existing token
async function trackToken(event) {
    if (event) event.preventDefault();

    const input = document.getElementById('trackInput');

    const token = input.value.trim().toUpperCase();

    const message = document.getElementById('trackMessage');

    if (!token) {
        message.textContent = 'Please enter your token number.';
        return;
    }

    try {
        const data = await request(
            '/ticket?token=' + encodeURIComponent(token)
        );

        currentToken = token;

        setText('trackingToken', data.ticket.token);
        setText('trackingStatus', data.ticket.status);

        setText(
            'trackingPosition',
            data.ticket.status === 'Waiting'
                ? data.position
                : '—'
        );

        setText(
            'trackingWait',
            data.ticket.status === 'Waiting'
                ? data.wait + ' min'
                : '—'
        );

        document.getElementById('trackingResult').hidden = false;

        message.textContent = '';

    } catch (error) {
        document.getElementById('trackingResult').hidden = true;
        message.textContent = error.message;
    }
}

// Automatically refresh current token
async function autoRefresh() {
    await loadState();

    if (currentToken) {
        document.getElementById('trackInput').value = currentToken;
        await trackToken();
    }
}

// Initialize application
document.addEventListener('DOMContentLoaded', () => {

    document.getElementById('joinForm')
        .addEventListener('submit', joinQueue);

    document.getElementById('trackForm')
        .addEventListener('submit', trackToken);

    document.getElementById('refreshTracking')
        .addEventListener('click', () => trackToken());

    // Restore previously generated token
    const savedToken = localStorage.getItem('queuelessToken');

    if (savedToken) {
        currentToken = savedToken;

        document.getElementById('trackInput').value = savedToken;
    }

    autoRefresh();

    // Refresh every five seconds
    setInterval(autoRefresh, 5000);
});
