# FF14 Discord Bot

A Discord bot designed for Final Fantasy XIV communities, featuring event management, PvP calculations, and utility functions.

## Features

### 🎯 Event Management
- Create and manage FF14 events (raids, trials, mount farms, etc.)
- Automated participant tracking with reactions
- Reminder system (24h, 12h, 1h before events)
- DM notifications for registrations and cancellations

### ⚔️ PvP Calculator
- Calculate Malmstone requirements between PvP levels
- Shows matches needed for different game modes
- Supports Crystalline Conflict, Frontline, and Rival Wings

### 🎲 Dice Rolling
- Animated dice rolling with visual effects
- Support for custom dice sides (2-100)
- Multiple dice rolling (up to 10)
- Fun result messages and statistics

## Setup

### Prerequisites
- Node.js (v16 or higher)
- Redis server
- Discord application with bot token

### Installation

1. Clone the repository and install dependencies:
```bash
npm install discord.js bullmq ioredis dotenv
```

2. Create a `.env` file in the root directory:
```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
AUTHORIZED_USERS=user_id_1,user_id_2,user_id_3
EVENT_CHANNEL_ID=channel_id_for_events
```

3. Start Redis server:

I recommend running redis as a container for safety and ease of use

```bash
# On Linux/Mac with Homebrew
brew services start redis

# On Linux with systemd
sudo systemctl start redis

# Or run directly
redis-server
```

4. Run the bot:
```bash
node bot.js
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Your Discord bot token from the Developer Portal |
| `CLIENT_ID` | Your Discord application ID |
| `AUTHORIZED_USERS` | Comma-separated list of user IDs who can create events, list active events and purge them (debug) |
| `EVENT_CHANNEL_ID` | Channel ID where events will be posted |

## Commands

### `/create-event`
Create a new FF14 event with the following options:
- **Type**: Maps, Extreme Trials, Savage Raids, Mount Farm, etc.
- **DateTime**: Format as `YYYY-MM-DD HH:MM` (UTC)
- **Description**: Optional additional details

```
/create-event type:savage_raids datetime:2024-12-25 20:00 description:P1S-P4S weekly clear
```

### `/pvp`
Calculate PvP Malmstone requirements:
- **Current Level**: Your current PvP level (1-40)
- **Goal Level**: Target PvP level (1-40)
- **Current Progress**: Optional XP progress in current level

```
/pvp current_level:15 goal_level:20 current_progress:5000
```

### `/roll`
Roll dice with animation:
- **Sides**: Number of sides (default: 6, max: 100)
- **Count**: Number of dice (default: 1, max: 10)

```
/roll sides:20 count:3
```

## Key Functions

### Event Management
- `handleCreateEvent()` - Creates new events and posts to designated channel
- `handleButtonInteraction()` - Processes participation and deletion buttons
- `scheduleReminders()` - Sets up automated reminder jobs
- `createEventEmbed()` - Generates event display embeds

### PvP System
- `calculatePvPXP()` - Core calculation logic for Malmstone requirements
- `handlePvPCalculator()` - Command handler with validation and formatting

### Utility Functions
- `rollDice()` - Animated dice rolling with visual effects
- `validateDateTime()` - Ensures proper event scheduling format

### Data Management
- `saveEventToRedis()` - Persists event data
- `getEventFromRedis()` - Retrieves event information
- `deleteEventFromRedis()` - Removes events from storage

## File Structure

```
├── bot.js              # Main bot file
├── config.json         # Runtime configuration (auto-generated)
├── bot.log            # Application logs (auto-generated)
├── uploads/           # File storage directory (auto-generated)
├── .env               # Environment variables
└── package.json       # Dependencies
```

## Event Types Supported

- Maps
- Extreme Trials
- Savage Raids
- Mount Farm
- Occult Crescent
- Blue Mage Skill Farm
- Minion Farm
- Treasure Trove Farm

## Reminder System

The bot uses BullMQ and Redis to manage automated reminders:
- Participants receive DMs 24 hours, 12 hours, and 1 hour before events
- Reminders are automatically cancelled if events are deleted
- Users are notified via DM when events are cancelled

## Permissions Required

The bot needs the following Discord permissions:
- Send Messages
- Use Slash Commands
- Embed Links
- Add Reactions
- Send Messages in DMs
- Read Message History

## Logging

The bot logs all activities to both console and `bot.log` file, including:
- Command usage
- Event creation/deletion
- Reminder notifications
- Error tracking

## Troubleshooting

### Common Issues

**Bot not responding to commands:**
- Verify the bot token is correct
- Check if slash commands are registered
- Ensure bot has proper permissions in the server

**Events not posting:**
- Verify `EVENT_CHANNEL_ID` is correct
- Check if bot has permissions in the target channel

**Reminders not working:**
- Ensure Redis server is running
- Check Redis connection logs

**Authorization errors:**
- Verify user IDs in `AUTHORIZED_USERS` are correct
- User IDs should be comma-separated without spaces

## Contributing

Feel free to submit issues and enhancement requests!