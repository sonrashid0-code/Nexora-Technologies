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
    // Organization accounts
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

    // Students belong to a specific organization.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS students (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            organization_id BIGINT NOT NULL
                REFERENCES organizations(id) ON DELETE CASCADE,
            student_number VARCHAR(50) NOT NULL,
            full_name VARCHAR(150) NOT NULL,
            class_name VARCHAR(80) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            UNIQUE (organization_id, student_number),
            UNIQUE (organization_id, id)
        )
    `);

    // Reports belong to the same organization as their student.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS student_reports (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            organization_id BIGINT NOT NULL
                REFERENCES organizations(id) ON DELETE CASCADE,
            student_id BIGINT NOT NULL,
            academic_year VARCHAR(20) NOT NULL,
            term VARCHAR(30) NOT NULL,
            report_data JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            FOREIGN KEY (organization_id, student_id)
                REFERENCES students (organization_id, id)
                ON DELETE CASCADE,

            UNIQUE (
                organization_id,
                student_id,
                academic_year,
                term
            )
        )
    `);

        console.log("Student and report tables are ready.");
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
// List students belonging only to the signed-in organization.
app.get("/api/students", async (req, res) => {
    try {
        const organizationId = req.session.organizationId;

        if (!organizationId) {
            return res.status(401).json({
                error: "Please log in first."
            });
        }

        const result = await pool.query(
            `SELECT id, student_number, full_name, class_name, created_at
             FROM students
             WHERE organization_id = $1
             ORDER BY full_name ASC`,
            [organizationId]
        );

        return res.json({
            students: result.rows
        });

    } catch (error) {
        console.error("Loading students failed:", error.message);

        return res.status(500).json({
            error: "Could not load students."
        });
    }
});


// Add a student to the signed-in organization's records.
app.post("/api/students", async (req, res) => {
    try {
        const organizationId = req.session.organizationId;

        if (!organizationId) {
            return res.status(401).json({
                error: "Please log in first."
            });
        }

        const body = req.body || {};

        const studentNumber =
            typeof body.studentNumber === "string"
                ? body.studentNumber.trim()
                : "";

        const fullName =
            typeof body.fullName === "string"
                ? body.fullName.trim()
                : "";

        const className =
            typeof body.className === "string"
                ? body.className.trim()
                : "";

        if (
            studentNumber.length < 1 ||
            studentNumber.length > 50
        ) {
            return res.status(400).json({
                error: "Student number must be 1–50 characters."
            });
        }

        if (fullName.length < 2 || fullName.length > 150) {
            return res.status(400).json({
                error: "Student name must be 2–150 characters."
            });
        }

        if (className.length < 1 || className.length > 80) {
            return res.status(400).json({
                error: "Class must be 1–80 characters."
            });
        }

        const result = await pool.query(
            `INSERT INTO students
                (organization_id, student_number, full_name, class_name)
             VALUES ($1, $2, $3, $4)
             RETURNING id, student_number, full_name, class_name, created_at`,
            [organizationId, studentNumber, fullName, className]
        );

        return res.status(201).json({
            message: "Student added successfully.",
            student: result.rows[0]
        });

    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({
                error: "That student number already exists in your organization."
            });
        }

        console.error("Adding student failed:", error.message);

        return res.status(500).json({
            error: "Could not add student."
        });
    }
});
// List reports belonging only to the signed-in organization.
app.get("/api/reports", async (req, res) => {
    try {
        const organizationId = req.session.organizationId;

        if (!organizationId) {
            return res.status(401).json({
                error: "Please log in first."
            });
        }

        const result = await pool.query(
            `SELECT
                r.id,
                r.student_id,
                s.student_number,
                s.full_name,
                s.class_name,
                r.academic_year,
                r.term,
                r.report_data,
                r.created_at
             FROM student_reports AS r
             JOIN students AS s
               ON s.id = r.student_id
              AND s.organization_id = r.organization_id
             WHERE r.organization_id = $1
             ORDER BY r.created_at DESC`,
            [organizationId]
        );

        return res.json({
            reports: result.rows
        });
    } catch (error) {
        console.error("Loading reports failed:", error.message);

        return res.status(500).json({
            error: "Could not load student reports."
        });
    }
});


// Save a report for a student in the signed-in organization.
app.post("/api/reports", async (req, res) => {
    try {
        const organizationId = req.session.organizationId;

        if (!organizationId) {
            return res.status(401).json({
                error: "Please log in first."
            });
        }

        const body = req.body || {};
        const studentId = Number(body.studentId);
        const academicYear =
            typeof body.academicYear === "string"
                ? body.academicYear.trim()
                : "";
        const term =
            typeof body.term === "string"
                ? body.term.trim()
                : "";
        const reportData = body.reportData;

        if (!Number.isSafeInteger(studentId) || studentId < 1) {
            return res.status(400).json({
                error: "Select a valid student."
            });
        }

        if (!academicYear || academicYear.length > 20) {
            return res.status(400).json({
                error: "Enter a valid academic year."
            });
        }

        if (!term || term.length > 30) {
            return res.status(400).json({
                error: "Enter a valid term."
            });
        }

        if (
            !reportData ||
            typeof reportData !== "object" ||
            Array.isArray(reportData)
        ) {
            return res.status(400).json({
                error: "Report data is required."
            });
        }

        if (
            !Array.isArray(reportData.subjects) ||
            reportData.subjects.length < 1 ||
            reportData.subjects.length > 20
        ) {
            return res.status(400).json({
                error: "Enter between 1 and 20 subject results."
            });
        }

        const subjects = [];

        for (const item of reportData.subjects) {
            if (!item || typeof item !== "object") {
                return res.status(400).json({
                    error: "Each subject result must be valid."
                });
            }

            const subject =
                typeof item.subject === "string"
                    ? item.subject.trim()
                    : "";

            const score = Number(item.score);

            const grade =
                typeof item.grade === "string"
                    ? item.grade.trim()
                    : "";

            if (!subject || subject.length > 80) {
                return res.status(400).json({
                    error: "Subject names must be 1–80 characters."
                });
            }

            if (
                item.score === "" ||
                item.score === null ||
                !Number.isFinite(score) ||
                score < 0 ||
                score > 100
            ) {
                return res.status(400).json({
                    error: "Subject scores must be between 0 and 100."
                });
            }

            if (grade.length > 10) {
                return res.status(400).json({
                    error: "A grade cannot exceed 10 characters."
                });
            }

            subjects.push({
                subject,
                score,
                grade
            });
        }

        const teacherComment =
            typeof reportData.teacherComment === "string"
                ? reportData.teacherComment.trim()
                : "";

        if (teacherComment.length > 1000) {
            return res.status(400).json({
                error: "Teacher comments cannot exceed 1000 characters."
            });
        }

        // Confirm the student belongs to this organization.
        const studentCheck = await pool.query(
            `SELECT id
             FROM students
             WHERE id = $1 AND organization_id = $2`,
            [studentId, organizationId]
        );

        if (studentCheck.rows.length === 0) {
            return res.status(404).json({
                error: "Student not found in your organization."
            });
        }

        const normalizedReport = {
            subjects,
            teacherComment
        };

        const result = await pool.query(
            `INSERT INTO student_reports
                (organization_id, student_id, academic_year, term, report_data)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             RETURNING id, student_id, academic_year, term,
                       report_data, created_at`,
            [
                organizationId,
                studentId,
                academicYear,
                term,
                JSON.stringify(normalizedReport)
            ]
        );

        return res.status(201).json({
            message: "Student report saved successfully.",
            report: result.rows[0]
        });

    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({
                error: "A report already exists for this student, year and term."
            });
        }

        console.error("Saving report failed:", error.message);

        return res.status(500).json({
            error: "Could not save the student report."
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