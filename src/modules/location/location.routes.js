const express = require("express");
const db = require("../../core/db/pool");

const router = express.Router();

router.get("/locations", async (req, res) => {
  try {
    const search = req.query.search;

    if (!search || search.length < 2) {
      return res.json([]);
    }

    const result = await db.query(
      `SELECT id, name, latitude, longitude
       FROM locations
       WHERE name ILIKE $1 || '%'
       ORDER BY similarity(name, $1) DESC
       LIMIT 10`,
      [search]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Location search error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
