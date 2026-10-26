const express = require("express");
const path = require("path");
const { Pool } = require("pg");

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

app.listen(PORT, () => {
    console.log(
        `Nexora Technologies is running on port ${PORT}`
    );
});