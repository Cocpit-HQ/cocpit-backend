CREATE TABLE IF NOT EXISTS tickets (
    ticket_id VARCHAR(50) PRIMARY KEY,
    event_id UUID REFERENCES events(event_id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'valid',
    checked_in_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
