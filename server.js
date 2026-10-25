
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Allow the server to read JSON requests later.
app.use(express.json());

// Serve the Nexora website files.
app.use(express.static(__dirname));

// Open the homepage.
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
    console.log(`Nexora Technologies is running at http://localhost:${PORT}`);
});
