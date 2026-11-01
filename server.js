
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');

require('dotenv').config();
const bcrypt = require('bcryptjs');
const sessions = new Map();
const SESSION_DURATION = 8 * 60 * 60 * 1000; // 8 hours

function getStaffSession(req) {
    const cookie = (req.headers.cookie || '')
        .split(';')
        .map(x => x.trim())
        .find(x => x.startsWith('ql_staff='));

    if (!cookie) return null;

    const sessionId = cookie.slice('ql_staff='.length);
    const session = sessions.get(sessionId);

    if (!session) return null;

    if (session.expiresAt < Date.now()) {
        sessions.delete(sessionId);
        return null;
    }

    return session;
}

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data.json');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});
const PUBLIC = path.join(__dirname, 'public');

// Default clinic data
function fresh() {
    return {
        clinic: {
            name: 'Sunrise Family Clinic',
            address: 'C-Scheme, Jaipur',
            open: '9:00 AM – 6:00 PM',
            grace: 5,
            notifyAhead: 2
        },

        services: [
            { id: 'consult', name: 'General consultation', icon: '🩺', duration: 6, active: true },
            { id: 'lab', name: 'Lab & diagnostics', icon: '🧪', duration: 4, active: true },
            { id: 'pharmacy', name: 'Pharmacy pickup', icon: '💊', duration: 3, active: true },
            { id: 'billing', name: 'Billing & insurance', icon: '🧾', duration: 5, active: true },
            { id: 'vaccine', name: 'Vaccination', icon: '💉', duration: 5, active: true }
        ],

        tickets: [],
        next: 1,
        served: 0,
        events: [],
        feedback: [],
        paused: false,
        startedAt: new Date().toISOString()
    };
}

// Load database
// Load database from Supabase
let db;

async function initializeDatabase() {
    try {
        const result = await pool.query(
            'SELECT data FROM app_state WHERE id = 1'
        );

        if (result.rows.length > 0) {
            db = result.rows[0].data;
            console.log('Database loaded from Supabase!');
        } else {
            if (fs.existsSync(DATA)) {
    db = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    console.log('Existing data.json loaded for migration!');
} else {
    db = fresh();
}

            await pool.query(
                `INSERT INTO app_state (id, data)
                 VALUES (1, $1)
                 ON CONFLICT (id) DO NOTHING`,
                [JSON.stringify(db)]
            );

            console.log('New database state created in Supabase!');
        }
    } catch (error) {
        console.error('Supabase initialization failed:', error);
        throw error;
    }
}

async function persist() {
    await pool.query(
        `INSERT INTO app_state (id, data, updated_at)
         VALUES (1, $1, NOW())
         ON CONFLICT (id)
         DO UPDATE SET data = EXCLUDED.data,
                       updated_at = NOW()`,
        [JSON.stringify(db)]
    );
}

function now() {
    return new Date().toISOString();
}

function token() {
    return 'Q-' + String(db.next++).padStart(3, '0');
}

// Send response
function send(res, status, data, type = 'application/json') {
    res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store'
    });

    res.end(
        type === 'application/json'
            ? JSON.stringify(data)
            : data
    );
}

// Read request body
function body(req) {
    return new Promise((resolve, reject) => {
        let s = '';

        req.on('data', d => {
            s += d;
            if (s.length > 100000) {
                req.destroy();
                reject(new Error('Request too large'));
            }
        });

        req.on('end', () => {
            try {
                resolve(s ? JSON.parse(s) : {});
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Queue statistics
function stats() {
    const done = db.tickets.filter(t => t.status === 'Served');

    const active = db.tickets.filter(t =>
        ['Waiting', 'Called', 'Serving'].includes(t.status)
    );

    const waiting = active.filter(t => t.status === 'Waiting');

    const avg = done.length
        ? Math.round(
            done.reduce((a, t) =>
                a + (t.actualMins || t.serviceDuration), 0
            ) / done.length
        )
        : 5;

    return {
        waiting: waiting.length,
        active: active.length,
        servedToday: db.served,
        averageService: avg,
        estimatedWait: waiting.reduce(
            (a, t) => a + t.serviceDuration, 0
        ),
        peopleInLine: waiting.length,
        physicalWaiting: waiting.filter(t => t.walkIn).length,

        servedPerHour: Math.round(
            db.served / Math.max(
                0.5,
                (Date.now() - new Date(db.startedAt).getTime()) / 3600000
            )
        ),

        accuracy: db.feedback.length
            ? Math.max(
                65,
                100 - Math.round(
                    db.feedback.reduce(
                        (a, f) => a + Math.abs(f.rating), 0
                    ) / db.feedback.length * 3
                )
            )
            : 88
    };
}

// Current application state
function snapshot() {
    const active = db.tickets.filter(t =>
        ['Waiting', 'Called', 'Serving'].includes(t.status)
    );

    return {
        clinic: db.clinic,
        services: db.services,
        tickets: db.tickets,
        queue: active,
        served: db.served,
        paused: db.paused,
        events: db.events.slice(-30),
        feedback: db.feedback,
        stats: stats(),
        serverTime: now()
    };
}

// Create server
const server = http.createServer(async (req, res) => {

    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    try {
        // STAFF LOGIN
if (p === '/api/login' && req.method === 'POST') {
    const b = await body(req);

    const validUsername =
        typeof b.username === 'string' &&
        b.username === process.env.ADMIN_USERNAME;

    const validPassword =
        typeof b.password === 'string' &&
        typeof process.env.ADMIN_PASSWORD_HASH === 'string' &&
        await bcrypt.compare(
            b.password,
            process.env.ADMIN_PASSWORD_HASH
        );

    if (!validUsername || !validPassword) {
        return send(res, 401, {
            error: 'Invalid username or password.'
        });
    }

    const sessionId = crypto.randomBytes(32).toString('hex');

sessions.set(sessionId, {
    username: b.username,
    expiresAt: Date.now() + SESSION_DURATION
});

res.setHeader(
    'Set-Cookie',
    `ql_staff=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`
);

return send(res, 200, {
    ok: true,
    message: 'Logged in successfully.'
});
}        // STAFF LOGOUT
if (p === '/api/logout' && req.method === 'POST') {
    const cookie = (req.headers.cookie || '')
        .split(';')
        .map(x => x.trim())
        .find(x => x.startsWith('ql_staff='));

    if (cookie) {
        sessions.delete(cookie.slice('ql_staff='.length));
    }

    res.setHeader(
        'Set-Cookie',
        'ql_staff=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
    );

    return send(res, 200, { ok: true });
}
        // PROTECT ADMIN ROUTES
      
const protectedRoutes = [
    '/api/next',
    '/api/serve',
    '/api/recall',
    '/api/missed',
    '/api/walkin',
    '/api/pause',
    '/api/settings',
    '/api/reset',
    '/api/analytics',
    '/api/export'
];

if (
    (p === '/admin.html' || p === '/admin.js' ||
     protectedRoutes.includes(p)) &&
    !getStaffSession(req)
) {
    if (p === '/admin.html') {
        res.writeHead(302, { Location: '/login.html' });
        return res.end();
    }

    return send(res, 401, {
        error: 'Staff login required.'
    });
}
        // GET STATE
        if (p === '/api/state' && req.method === 'GET') {
            return send(res, 200, snapshot());
        }

        // JOIN QUEUE
        if (p === '/api/join' && req.method === 'POST') {

            const b = await body(req);

            const service = db.services.find(
                s => s.id === b.serviceId && s.active
            );

            if (!service) {
                return send(res, 400, {
                    error: 'Please choose an available service.'
                });
            }

            const t = {
                id: crypto.randomUUID(),
                token: token(),
                serviceId: service.id,
                service: service.name,
                serviceIcon: service.icon,
                serviceDuration: Number(service.duration),

                name: String(b.name || 'Guest').trim().slice(0, 50),
                phone: String(b.phone || '').slice(0, 25),
                walkIn: !!b.walkIn,

                createdAt: now(),
                calledAt: null,
                completedAt: null,
                status: 'Waiting',
                note: ''
            };

            db.tickets.push(t);

            db.events.push({
                at: now(),
                text: `${t.token} joined ${t.service}.`
            });

            await persist();

            const waiting = db.tickets.filter(
                x => x.status === 'Waiting'
            );

            return send(res, 201, {
                ticket: t,
                position: waiting.findIndex(x => x.id === t.id) + 1,
                wait: waiting.reduce(
                    (a, x) => a + x.serviceDuration, 0
                ),
                state: snapshot()
            });
        }

        // TRACK TICKET
        if (p === '/api/ticket' && req.method === 'GET') {

            const t = db.tickets.find(t =>
                t.id === u.searchParams.get('id') ||
                t.token === u.searchParams.get('token')
            );

            if (!t) {
                return send(res, 404, {
                    error: 'Token not found'
                });
            }

            const queue = db.tickets.filter(
                x => x.status === 'Waiting'
            );

            const position = t.status === 'Waiting'
                ? queue.findIndex(x => x.id === t.id) + 1
                : 0;

            const wait = queue
                .slice(0, Math.max(0, position))
                .reduce((a, x) => a + x.serviceDuration, 0);

            return send(res, 200, {
                ticket: t,
                position,
                wait,
                state: snapshot()
            });
        }

        // CALL NEXT
        if (p === '/api/next' && req.method === 'POST') {

            if (db.paused) {
                return send(res, 409, {
                    error: 'Queue is paused.'
                });
            }

            const b = await body(req);

            const current = db.tickets.find(
                t => t.status === 'Serving'
            );

            if (current) {
                return send(res, 409, {
                    error: `Finish serving ${current.token} first.`
                });
            }

            const t = db.tickets.find(x =>
                x.status === 'Waiting' &&
                (!b.serviceId || x.serviceId === b.serviceId)
            );

            if (!t) {
                return send(res, 404, {
                    error: 'No waiting tickets.'
                });
            }

            t.status = 'Called';
            t.calledAt = now();

            db.events.push({
                at: now(),
                text: `${t.token} called to ${b.counter || 'Counter 1'}.`
            });

            await persist();

            return send(res, 200, {
                ticket: t,
                state: snapshot()
            });
        }

        // MARK SERVED
        if (p === '/api/serve' && req.method === 'POST') {

            const b = await body(req);

            const t = db.tickets.find(x => x.id === b.id) ||
                db.tickets.find(x => x.status === 'Called');

            if (!t || !['Called', 'Serving'].includes(t.status)) {
                return send(res, 404, {
                    error: 'Call a ticket first.'
                });
            }

            t.status = 'Served';
            t.completedAt = now();

            t.actualMins = Math.max(
                1,
                Math.round(
                    (Date.now() - new Date(
                        t.calledAt || t.createdAt
                    ).getTime()) / 60000
                )
            );

            db.served++;

            db.events.push({
                at: now(),
                text: `${t.token} marked served.`
            });

            await persist();

            return send(res, 200, {
                ticket: t,
                state: snapshot()
            });
        }

        // RECALL
        if (p === '/api/recall' && req.method === 'POST') {

            const b = await body(req);

            const t = db.tickets.find(x => x.id === b.id) ||
                db.tickets.find(x => x.status === 'Called');

            if (!t || t.status !== 'Called') {
                return send(res, 404, {
                    error: 'No called ticket to recall.'
                });
            }

            db.events.push({
                at: now(),
                text: `Reminder recorded for ${t.token}.`
            });

            await persist();

            return send(res, 200, {
                ok: true,
                state: snapshot()
            });
        }

        // MISSED TICKET
        if (p === '/api/missed' && req.method === 'POST') {

            const b = await body(req);

            const t = db.tickets.find(x => x.id === b.id);

            if (!t || !['Called', 'Waiting'].includes(t.status)) {
                return send(res, 404, {
                    error: 'Ticket not found in active queue.'
                });
            }

            t.status = 'Missed';
            t.completedAt = now();

            db.events.push({
                at: now(),
                text: `${t.token} marked missed.`
            });

            await persist();

            return send(res, 200, {
                state: snapshot()
            });
        }

        // CANCEL TICKET
        if (p === '/api/cancel' && req.method === 'POST') {

            const b = await body(req);

            const t = db.tickets.find(x =>
                x.id === b.id || x.token === b.token
            );

            if (!t || !['Waiting', 'Called'].includes(t.status)) {
                return send(res, 404, {
                    error: 'This ticket cannot be cancelled.'
                });
            }

            t.status = 'Cancelled';

            db.events.push({
                at: now(),
                text: `${t.token} cancelled.`
            });

            await persist();

            return send(res, 200, {
                state: snapshot()
            });
        }

        // WALK-IN TOKEN
        if (p === '/api/walkin' && req.method === 'POST') {

            const b = await body(req);

            const service = db.services.find(
                s => s.id === b.serviceId && s.active
            );

            if (!service) {
                return send(res, 400, {
                    error: 'Please choose an available service.'
                });
            }

            const t = {
                id: crypto.randomUUID(),
                token: token(),
                serviceId: service.id,
                service: service.name,
                serviceIcon: service.icon,
                serviceDuration: Number(service.duration),

                name: String(b.name || 'Walk-in').slice(0, 50),
                phone: '',
                walkIn: true,

                createdAt: now(),
                calledAt: null,
                completedAt: null,
                status: 'Waiting',
                note: ''
            };

            db.tickets.push(t);

            db.events.push({
                at: now(),
                text: `${t.token} issued for walk-in.`
            });

            await persist();

            return send(res, 201, {
                ticket: t,
                state: snapshot()
            });
        }

        // PAUSE / RESUME
        if (p === '/api/pause' && req.method === 'POST') {

            db.paused = !db.paused;

            db.events.push({
                at: now(),
                text: `Queue ${db.paused ? 'paused' : 'resumed'}.`
            });

            await persist();

            return send(res, 200, {
                paused: db.paused,
                state: snapshot()
            });
        }

        // SETTINGS
        if (p === '/api/settings' && req.method === 'PATCH') {

            const b = await body(req);

            if (b.clinic) {
                db.clinic = {
                    ...db.clinic,
                    ...b.clinic
                };
            }

            if (b.services) {
                db.services = db.services.map(s => ({
                    ...s,
                    ...(b.services.find(x => x.id === s.id) || {})
                }));
            }

            await persist();

            return send(res, 200, snapshot());
        }

        // RESET
        if (p === '/api/reset' && req.method === 'POST') {

            db = fresh();
            await persist();

            return send(res, 200, snapshot());
        }

        // ANALYTICS
        if (p === '/api/analytics' && req.method === 'GET') {

            const all = db.tickets;

            const done = all.filter(
                t => t.status === 'Served'
            );

            const byService = db.services.map(s => ({
                name: s.name,
                count: all.filter(
                    t => t.serviceId === s.id
                ).length,
                served: done.filter(
                    t => t.serviceId === s.id
                ).length,
                avg: s.duration
            }));

            const hourly = [
                { label: '9a', value: 5 },
                { label: '10a', value: 9 },
                { label: '11a', value: 14 },
                { label: '12p', value: 11 },
                { label: '1p', value: 8 },
                { label: '2p', value: 13 },
                { label: '3p', value: 10 },
                {
                    label: 'Now',
                    value: db.tickets.filter(
                        t => t.status === 'Waiting'
                    ).length
                }
            ];

            return send(res, 200, {
                stats: stats(),
                byService,
                hourly,
                feedback: db.feedback,
                history: all.slice().reverse().slice(0, 40),
                state: snapshot()
            });
        }

        // FEEDBACK
        if (p === '/api/feedback' && req.method === 'POST') {

            const b = await body(req);

            db.feedback.push({
                rating: Math.max(1, Math.min(5, +b.rating || 5)),
                comment: String(b.comment || '').slice(0, 240),
                at: now(),
                token: b.token || ''
            });

            await persist();

            return send(res, 200, {
                ok: true
            });
        }

        // EXPORT
        if (p === '/api/export' && req.method === 'GET') {
            return send(
                res,
                200,
                JSON.stringify(db.tickets, null, 2),
                'application/json'
            );
        }

        // UNKNOWN API
        if (p.startsWith('/api/')) {
            return send(res, 404, {
                error: 'API route not found.'
            });
        }

        // SERVE FRONTEND FILES
        const requestedFile = p === '/'
            ? 'index.html'
            : p.slice(1);

        const filePath = path.resolve(PUBLIC, requestedFile);

        if (!filePath.startsWith(PUBLIC + path.sep)) {
            return send(res, 403, 'Forbidden', 'text/plain');
        }

        const ext = path.extname(filePath);

        const types = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.json': 'application/json',
            '.svg': 'image/svg+xml'
        };

        fs.readFile(filePath, (err, data) => {

            if (err) {
                return send(res, 404, 'Not found', 'text/plain');
            }

            send(
                res,
                200,
                data,
                types[ext] || 'application/octet-stream'
            );
        });

    } catch (e) {

        send(res, 500, {
            error: e.message || 'Unexpected server error.'
        });

    }
});


// START SERVER
async function startServer() {
    try {
        await initializeDatabase();

        server.listen(PORT, '0.0.0.0', () => {
            console.log('');
            console.log('================================');
            console.log('   QUEUELESS SERVER RUNNING');
            console.log('================================');
            console.log(`Website running on port ${PORT}`);
            console.log(`Admin: /admin.html`);
            console.log(`API: /api/state`);
            console.log('================================');
        });
    } catch (error) {
        console.error('Server startup failed:', error);
        process.exit(1);
    }
}

startServer();
