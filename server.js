const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);

const app = express();
const PORT = process.env.PORT || 5001;

app.use(express.json());
app.use(express.static(__dirname));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? false
        : undefined
});
app.set("trust proxy", 1);

if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is missing.");
}

app.use(session({
    store: new PgSession({
        pool,
        tableName: "user_sessions",
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: "auto",
        sameSite: "lax",
        maxAge: 8 * 60 * 60 * 1000
    }
}));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});
async function initializeDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS organizations (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            organization_name VARCHAR(150) NOT NULL,
            email VARCHAR(254) NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    console.log("Organizations table is ready.");
}

app.get("/api/health", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT NOW() AS database_time"
        );

        res.json({
            status: "connected",
            database: "Nexora PostgreSQL",
            time: result.rows[0].database_time
        });
    } catch (error) {
        console.error("Database connection failed:", error.message);
        res.status(500).json({
            status: "error",
            message: "Database connection failed"
        });
    }
});
app.post("/api/organizations/register", async (req, res) => {
    try {
        const organizationName =
            typeof req.body.organizationName === "string"
                ? req.body.organizationName.trim()
                : "";

        const email =
            typeof req.body.email === "string"
                ? req.body.email.trim().toLowerCase()
                : "";

        const password =
            typeof req.body.password === "string"
                ? req.body.password
                : "";

        if (organizationName.length < 2 ||
            organizationName.length > 150) {
            return res.status(400).json({
                error: "Organization name must be 2–150 characters."
            });
        }

        if (email.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({
                error: "Enter a valid email address."
            });
        }

        if (password.length < 10 ||
            Buffer.byteLength(password, "utf8") > 72) {
            return res.status(400).json({
                error: "Password must be at least 10 characters and no more than 72 bytes."
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const result = await pool.query(
            `INSERT INTO organizations
                (organization_name, email, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, organization_name, email, created_at`,
            [organizationName, email, passwordHash]
        );

        return res.status(201).json({
            message: "Organization registered successfully.",
            organization: result.rows[0]
        });

    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({
                error: "An organization with that email already exists."
            });
        }

        console.error("Organization registration failed:", error.message);

        return res.status(500).json({
            error: "Registration failed. Please try again."
        });
    }
});
// Organization login
app.post("/api/organizations/login", async (req, res) => {
    try {
        const body = req.body || {};

        const email =
            typeof body.email === "string"
                ? body.email.trim().toLowerCase()
                : "";

        const password =
            typeof body.password === "string"
                ? body.password
                : "";

        if (!email || !password) {
            return res.status(400).json({
                error: "Email and password are required."
            });
        }

        const result = await pool.query(
            `SELECT id, organization_name, email, password_hash
             FROM organizations
             WHERE email = $1`,
            [email]
        );

        const organization = result.rows[0];

        if (
            !organization ||
            !(await bcrypt.compare(password, organization.password_hash))
        ) {
            return res.status(401).json({
                error: "Invalid email or password."
            });
        }

        // Renew the session after successful login.
        await new Promise((resolve, reject) => {
            req.session.regenerate((error) => {
                if (error) reject(error);
                else resolve();
            });
        });

        req.session.organizationId = String(organization.id);

        await new Promise((resolve, reject) => {
            req.session.save((error) => {
                if (error) reject(error);
                else resolve();
            });
        });

        return res.json({
            message: "Login successful.",
            organization: {
                id: organization.id,
                organization_name: organization.organization_name,
                email: organization.email
            }
        });

    } catch (error) {
        console.error("Organization login failed:", error.message);

        return res.status(500).json({
            error: "Login failed. Please try again."
        });
    }
});


// Check the currently logged-in organization
app.get("/api/organizations/me", async (req, res) => {
    try {
        if (!req.session.organizationId) {
            return res.status(401).json({
                error: "Please log in first."
            });
        }

        const result = await pool.query(
            `SELECT id, organization_name, email, created_at
             FROM organizations
             WHERE id = $1`,
            [req.session.organizationId]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                error: "Organization account not found."
            });
        }

        return res.json({
            organization: result.rows[0]
        });

    } catch (error) {
        console.error("Account check failed:", error.message);

        return res.status(500).json({
            error: "Could not load the organization account."
        });
    }
});


// Organization logout
app.post("/api/organizations/logout", (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            console.error("Logout failed:", error.message);

            return res.status(500).json({
                error: "Logout failed. Please try again."
            });
        }

        res.clearCookie("connect.sid", {
            path: "/",
            httpOnly: true,
            sameSite: "lax"
        });

        return res.json({
            message: "Logged out successfully."
        });
    });
});
initializeDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(
                `Nexora Technologies is running on port ${PORT}`
            );
        });
    })
    .catch((error) => {
        console.error("Database initialization failed:", error.message);
        process.exit(1);
    });