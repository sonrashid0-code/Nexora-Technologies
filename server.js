const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

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