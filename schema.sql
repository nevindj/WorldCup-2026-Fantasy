CREATE DATABASE IF NOT EXISTS worldfantasy;
USE worldfantasy;

DROP TABLE IF EXISTS contest_entries;
DROP TABLE IF EXISTS user_teams;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS match_lineups;

CREATE TABLE users (
  id VARCHAR(255) PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  totalScore INT DEFAULT 0,
  wallet INT DEFAULT 1000,
  premium_until DATETIME DEFAULT NULL,
  premium_plan VARCHAR(50) DEFAULT NULL
);

CREATE TABLE user_teams (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  match_id INT NOT NULL,
  team_name VARCHAR(255) NOT NULL,
  formation VARCHAR(50) NOT NULL,
  captain VARCHAR(255) NOT NULL,
  vice_captain VARCHAR(255) NOT NULL,
  simulated_points INT DEFAULT 0,
  points_breakdown JSON,
  real_stats BOOLEAN DEFAULT FALSE,
  players JSON,
  created_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE match_lineups (
  match_id INT PRIMARY KEY,
  home_lineup JSON,
  home_subs JSON,
  away_lineup JSON,
  away_subs JSON,
  confirmed_at DATETIME,
  source VARCHAR(100)
);

-- Tracks each user's contest entry per match
CREATE TABLE contest_entries (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  match_id INT NOT NULL,
  entry_fee INT DEFAULT 100,
  prize INT DEFAULT 0,
  status ENUM('entered', 'won', 'lost') DEFAULT 'entered',
  created_at DATETIME NOT NULL,
  UNIQUE KEY unique_user_match (user_id, match_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
