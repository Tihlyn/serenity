const { Client, GatewayIntentBits, ActivityType, SlashCommandBuilder, REST, Routes, AttachmentBuilder } = require('discord.js');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');

// Configuration
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS; 
const EVENT_CHANNEL_ID = process.env.EVENT_CHANNEL_ID; 
//redis connection info & logging
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  lazyConnect: true,
  maxRetriesPerRequest : null,
});
redis.on('connect', () => {
  console.log('connection success');
});
redis.on('error', (err) => {
  console.error('something went wrong');
});
redis.on('ready', () => {
  console.log('redis be workin');
});

// BullMQ Queue for reminders
const reminderQueue = new Queue('event-reminders', { connection: redis });


// Redis management functions
async function saveEventToRedis(event) {
  await redis.hset('events', event.id, JSON.stringify(event));
}

async function getEventFromRedis(eventId) {
  const data = await redis.hget('events', eventId);
  return data ? JSON.parse(data) : null;
}

async function deleteEventFromRedis(eventId) {
  await redis.hdel('events', eventId);
}





const EVENT_TYPES = [
  { name: 'Maps', value: 'maps' },
  { name: 'Extreme Trials', value: 'extreme_trials' },
  { name: 'Savage Raids', value: 'savage_raids' },
  { name: 'Mount Farm', value: 'mount_farm' },
  { name: 'Occult Crescent', value: 'occult_crescent' },
  { name: 'Blue Mage Skill Farm', value: 'blue_mage_skill_farm' },
  { name: 'Minion Farm', value: 'minion_farm' },
  { name: 'Treasure Trove Farm', value: 'treasure_trove_farm' },

];


const eventCommand = new SlashCommandBuilder()
  .setName('create-event')
  .setDescription('Create a new FF14 event')
  .addStringOption(option =>
    option.setName('type')
      .setDescription('Type of event')
      .setRequired(true)
      .addChoices(...EVENT_TYPES)
  )
  .addStringOption(option =>
    option.setName('datetime')
      .setDescription('Date and time (YYYY-MM-DD HH:MM UTC)')
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName('description')
      .setDescription('Additional event description (optional)')
      .setRequired(false)
  );

// check for valid time and date
function validateDateTime(dateTimeString) {
  const regex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
  if (!regex.test(dateTimeString)) {
    return { valid: false, error: 'Invalid format. Use: YYYY-MM-DD HH:MM' };
  }

  const eventDate = new Date(dateTimeString + ' UTC');
  const now = new Date();

  if (isNaN(eventDate.getTime())) {
    return { valid: false, error: 'Invalid date or time.' };
  }

  if (eventDate <= now) {
    return { valid: false, error: 'Event date must be in the future.' };
  }

  return { valid: true, date: eventDate };
}


function createEventEmbed(eventType, eventDate, organizer, description = '', participants = []) {
  const embed = new EmbedBuilder()
    .setTitle(`📅 ${EVENT_TYPES.find(t => t.value === eventType)?.name || eventType}`)
    .setColor(0x49bbbb)
    .addFields(
      { name: '🗓️ Date & Time', value: `<t:${Math.floor(eventDate.getTime() / 1000)}:F>`, inline: true },
      { name: '⏰ Relative Time', value: `<t:${Math.floor(eventDate.getTime() / 1000)}:R>`, inline: true },
      { name: '👤 Organizer', value: `<@${organizer}>`, inline: true }
    )
    .setTimestamp();

  if (description) {
    embed.addFields({ name: '📝 Description', value: description });
  }

  if (participants.length > 0) {
    const participantList = participants.map(id => `<@${id}>`).join('\n');
    embed.addFields({ 
      name: `👥 Participants (${participants.length})`, 
      value: participantList.length > 1024 ? `${participantList.substring(0, 1020)}...` : participantList 
    });
  } else {
    embed.addFields({ name: '👥 Participants (0)', value: 'No participants yet' });
  }

  return embed;
}


function createEventButtons(eventId, organizerId, currentUserId) {
  const row = new ActionRowBuilder();
  
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`participate_${eventId}`)
      .setLabel('Participate')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('✅')
  );

  // Only show delete button to the organizer
  if (currentUserId === organizerId) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`delete_${eventId}`)
        .setLabel('Delete Event')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️')
    );
  }

  return row;
}

// Schedule reminder jobs
async function scheduleReminders(eventId, eventDate, participants) {
  const eventTimestamp = eventDate.getTime();
  const now = Date.now();  
  const reminderTimes = [
    { delay: 24 * 60 * 60 * 1000, label: '24 hours' },
    { delay: 12 * 60 * 60 * 1000, label: '12 hours' },
    { delay: 1 * 60 * 60 * 1000, label: '1 hour' }
  ];

  for (const participant of participants) {
    for (const reminder of reminderTimes) {
      const reminderTime = eventTimestamp - reminder.delay;
      
      if (reminderTime > now) {
        const jobName = `reminder_${eventId}_${participant}_${reminder.label}`;
        const delay = reminderTime - now;

        await reminderQueue.add(jobName, {
          eventId,
          participantId: participant,
          reminderType: reminder.label,
          eventDate: eventTimestamp
        }, {
          delay,
          removeOnComplete: true,
          removeOnFail: true
        });
      }
    }
  }
}

// Cancel all reminders for an event
async function cancelEventReminders(eventId) {
  const jobs = await reminderQueue.getJobs(['waiting', 'delayed']);
  const eventJobs = jobs.filter(job => job.data.eventId === eventId);
  
  for (const job of eventJobs) {
    await job.remove();
  }
}

async function handleCreateEvent(interaction) {  
// Ensure AUTHORIZED_USERS is a comma-separated string of IDs
const authorizedIds = (process.env.AUTHORIZED_USERS || '').split(',').map(id => id.trim()).filter(Boolean);
if (!authorizedIds.includes(interaction.user.id)) {
    return interaction.reply({ 
        content: '❌ You are not authorized to create events.', 
        ephemeral: true 
    });
}

  const eventType = interaction.options.getString('type');
  const dateTimeString = interaction.options.getString('datetime');
  const description = interaction.options.getString('description') || '';

  
  const validation = validateDateTime(dateTimeString);
  if (!validation.valid) {
    return interaction.reply({ 
      content: `❌ ${validation.error}`, 
      ephemeral: true 
    });
  }

  const eventId = `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const eventDate = validation.date;
  
  const event = {
  id: eventId,
  type: eventType,
  date: eventDate,
  organizer: interaction.user.id,
  description,
  participants: [],
  messageId: null
};


  
  const embed = createEventEmbed(eventType, eventDate, interaction.user.id, description);
  const buttons = createEventButtons(eventId, interaction.user.id, interaction.user.id);

  const EVENT_CHANNEL_ID = (process.env.EVENT_CHANNEL_ID || '').trim();
const channel = interaction.client.channels.cache.get(EVENT_CHANNEL_ID);

if (!channel) {
  // Debug log for troubleshooting
  console.error('EVENT_CHANNEL_ID from .env:', EVENT_CHANNEL_ID);
  console.error('Available channel IDs:', [...interaction.client.channels.cache.keys()]);
  return interaction.reply({ 
    content: `❌ Event channel not found. Bonk the dev. (ID: ${EVENT_CHANNEL_ID})`, 
    ephemeral: true 
  });
}

  try {
    const message = await channel.send({ 
      embeds: [embed], 
      components: [buttons] 
    });

    // Update event data with message ID
    event.messageId = message.id;
    await saveEventToRedis(event);

    await interaction.reply({ 
      content: `✅ Event created successfully! Check ${channel}`, 
      ephemeral: true 
    });
  } catch (error) {
    console.error('Error creating event:', error);
    await interaction.reply({ 
      content: '❌ Failed to create event. Bonk April.', 
      ephemeral: true 
    });
  }
}

async function handleButtonInteraction(interaction) {
  const [action, ...eventIdParts] = interaction.customId.split('_');
  const eventId = eventIdParts.join('_');
  const event = await getEventFromRedis(eventId);
  if (event && event.date && !(event.date instanceof Date)) {
    event.date = new Date(event.date);
  }
  console.log('eventId:', eventId, 'event:', event);
  if (!event) {
    return interaction.reply({ 
      content: '❌ Event not found.', 
      ephemeral: true 
    });
  }

  if (action === 'participate') {
    const userId = interaction.user.id;

    if (event.participants.includes(userId)) {
      return interaction.reply({ 
        content: '⚠️ You are already participating in this event!', 
        ephemeral: true 
      });
    }

    
    event.participants.push(userId);
    await saveEventToRedis(event);

    
    await scheduleReminders(eventId, event.date, [userId]);

    
    const embed = createEventEmbed(event.type, event.date, event.organizer, event.description, event.participants);
    const buttons = createEventButtons(eventId, event.organizer, event.organizer);

    await interaction.update({ 
      embeds: [embed], 
      components: [buttons] 
    });

    // Send confirmation DM
    try {
      const user = await interaction.client.users.fetch(userId);
      const eventTypeName = EVENT_TYPES.find(t => t.value === event.type)?.name || event.type;
      
      await user.send({
        embeds: [new EmbedBuilder()
          .setTitle('✅ Event Registration Confirmed')
          .setDescription(`You have successfully registered for: **${eventTypeName}**`)
          .addFields(
            { name: '🗓️ Date & Time', value: `<t:${Math.floor(event.date.getTime() / 1000)}:F>` },
            { name: '⏰ Relative Time', value: `<t:${Math.floor(event.date.getTime() / 1000)}:R>` }
          )
          .setColor(0x49bbbb)
          .setTimestamp()]
      });
    } catch (error) {
      console.error('Could not send DM to user:', error);
    }

  } else if (action === 'delete') {
    // Only organizer can delete
    if (interaction.user.id !== event.organizer) {
      return interaction.reply({ 
        content: '❌ Only the event organizer can delete this event.', 
        ephemeral: true 
      });
    }

    // Cancel all reminders
    await cancelEventReminders(eventId);

    const eventTypeName = EVENT_TYPES.find(t => t.value === event.type)?.name || event.type;
    for (const participantId of event.participants) {
      if (participantId === event.organizer) continue;
      try {
        const user = await interaction.client.users.fetch(participantId);
        await user.send({
          embeds: [new EmbedBuilder()
            .setTitle('❌ Event Cancelled')
            .setDescription(`The **${eventTypeName}** event you registered for has been cancelled by the organizer.`)
            .addFields(
              { name: 'Originally Scheduled', value: `<t:${Math.floor(event.date.getTime() / 1000)}:F>` }
            )
            .setColor(0xFF0000)
            .setTimestamp()]
        });
      } catch (error) {
        console.error(`Could not send cancellation DM to user ${participantId}:`, error);
      }
    }

    // Remove from storage
    await deleteEventFromRedis(eventId);

    // Delete the message
    await interaction.message.delete();

    await interaction.reply({ 
      content: '✅ Event deleted successfully.', 
      ephemeral: true 
    });
  }
}

// BullMQ Worker for processing reminders
const reminderWorker = new Worker('event-reminders', async (job) => {
  const { eventId, participantId, reminderType, eventDate } = job.data;
  
  // Check if event still exists
  const event = await getEventFromRedis(eventId);
  if (!event) {
    console.log(`Event ${eventId} no longer exists, skipping reminder`);
    return;
  }

  // Check if user is still a participant
  if (!event.participants.includes(participantId)) {
    console.log(`User ${participantId} no longer participating in ${eventId}, skipping reminder`);
    return;
  }

  try {
    const user = await job.queue.client.users?.fetch?.(participantId);
    if (!user) {
      console.log(`Could not fetch user ${participantId} for reminder`);
      return;
    }

    const eventTypeName = EVENT_TYPES.find(t => t.value === event.type)?.name || event.type;
    
    const embed = new EmbedBuilder()
      .setTitle(`⏰ Event Reminder - ${reminderType} remaining`)
      .setDescription(`Don't forget about the **${eventTypeName}** event!`)
      .addFields(
        { name: '🗓️ Date & Time', value: `<t:${Math.floor(eventDate / 1000)}:F>` },
        { name: '⏰ Time Remaining', value: `<t:${Math.floor(eventDate / 1000)}:R>` }
      )
      .setColor(0xFFAA00)
      .setTimestamp();

    if (event.description) {
      embed.addFields({ name: '📝 Description', value: event.description });
    }

    await user.send({ embeds: [embed] });
    console.log(`Sent ${reminderType} reminder to ${user.tag} for event ${eventId}`);
    
  } catch (error) {
    console.error(`Failed to send reminder to ${participantId}:`, error);
  }
}, { connection: redis });

// Error handling for worker
reminderWorker.on('failed', (job, err) => {
  console.error(`Reminder job ${job.id} failed:`, err);
});







const pvpLvl = [
    0, 0, 2000, 4000, 6000, 8000, 11000, 14000, 17000, 20000, 23000, 27000, 
    31000, 35000, 39000, 43000, 48500, 54000, 59500, 65000, 70500, 78000, 85500, 
    93000, 100500, 108000, 118000, 128000, 138000, 148000, 158000, 178000, 198000, 
    218000, 238000, 258000, 278000, 298000, 318000, 338000, 358000
];


const frontlineWin_Exp = 1500;
const frontlineLose2_Exp = 1250;
const frontlineLose_Exp = 1000;
const frontlineDailyWin_Exp = 3000;
const frontlineDailyLose2_Exp = 2750;
const frontlineDailyLose_Exp = 2500;
const CrystalineWin_Exp = 900;
const CrystalineLose_Exp = 700;
const rivalwingsWin_Exp = 1250;
const rivalwingsLose_Exp = 750;


const TOKEN = process.env.DISCORD_TOKEN; 
const CLIENT_ID = process.env.CLIENT_ID;


// Bot setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.DirectMessageTyping,
        GatewayIntentBits.GuildMembers
    ],
    presence: {
        activities: [{
            name: 'Percolating',
            type: ActivityType.Custom
        }]
    }
});


// Data storage
let config = {
    predUserIds: process.env.AUTHORIZED_USERS,    
    
};

// Logging function
function log(message, level = 'DEBUG') {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} ${level}: ${message}`;
    console.log(logMessage);        
    fs.appendFile('bot.log', logMessage + '\n').catch(console.error);
}

async function loadConfig() {
    try {
        const data = await fs.readFile('config.json', 'utf8');
        config = { ...config, ...JSON.parse(data) };
        log('Configuration loaded');
    } catch (error) {
        log('No existing config found, using defaults', 'WARN');
    }
}

async function saveConfig() {
    try {
        await fs.writeFile('config.json', JSON.stringify(config, null, 2));
        log('Configuration saved');
    } catch (error) {
        log(`Error saving config: ${error.message}`, 'ERROR');
    }
}

// We talking
async function sendMessages(message, imagePaths = []) {
    for (const userId of config.predUserIds) {
        try {
            const user = await client.users.fetch(userId);                      
                        
            await user.send({ content: message });
            log(`Message sent to ${userId}: ${message}`);
        } catch (error) {
            log(`Error sending message to ${userId}: ${error.message}`, 'ERROR');
        }
    }
}


// Here be PvP
function calculatePvPXP(currentLevel, goalLevel, currentProgress) {
    // Validation
    if (currentLevel < 1 || currentLevel > 40) {
        throw new Error('Current level must be between 1 and 40');
    }
    if (goalLevel < 1 || goalLevel > 40) {
        throw new Error('Goal level must be between 1 and 40');
    }
    if (currentLevel >= goalLevel) {
        throw new Error('Goal level must be higher than current level');
    }
    
    const current_level_memory = pvpLvl[currentLevel];
    const goal_level_memory = pvpLvl[goalLevel];
    const maxProgress = goal_level_memory - current_level_memory;
    
    if (currentProgress < 0 || currentProgress >= maxProgress) {
        throw new Error(`Current progress must be between 0 and ${maxProgress - 1}`);
    }
    
    const exp = goal_level_memory - current_level_memory - currentProgress;

    // match calculation
    const results = {
        expNeeded: exp,
        crystallineConflict: {
            wins: Math.ceil(exp / CrystalineWin_Exp),
            losses: Math.ceil(exp / CrystalineLose_Exp)
        },
        frontline: {
            wins: Math.ceil(exp / frontlineWin_Exp),
            secondPlace: Math.ceil(exp / frontlineLose2_Exp),
            losses: Math.ceil(exp / frontlineLose_Exp)
        },
        frontlineDaily: {
            wins: Math.ceil(exp / frontlineDailyWin_Exp),
            secondPlace: Math.ceil(exp / frontlineDailyLose2_Exp),
            losses: Math.ceil(exp / frontlineDailyLose_Exp)
        },
        rivalWings: {
            wins: Math.ceil(exp / rivalwingsWin_Exp),
            losses: Math.ceil(exp / rivalwingsLose_Exp)
        }
    };

    return results;
}


async function handlePvPCalculator(interaction) {
    const currentLevel = interaction.options.getInteger('current_level');
    const goalLevel = interaction.options.getInteger('goal_level');
    const currentProgress = interaction.options.getInteger('current_progress') || 0;

    try {        
        await interaction.reply({
            content: '⚔️ Calculating your PvP Malmstone requirements... ⚔️',
            ephemeral: true
        });

        // Add small delay for effect
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const results = calculatePvPXP(currentLevel, goalLevel, currentProgress);

        
        let responseMessage = `⚔️ **PvP Malmstone Calculator** ⚔️\n`;
        responseMessage += `📊 **From Level ${currentLevel} to Level ${goalLevel}**\n`;
        if (currentProgress > 0) {
            responseMessage += `📈 **Current Progress:** ${currentProgress.toLocaleString()} XP\n`;
        }
        responseMessage += `🎯 **XP Needed:** ${results.expNeeded.toLocaleString()}\n\n`;

        responseMessage += `**📋 Matches Required:**\n`;
        responseMessage += `\`\`\`\n`;
        responseMessage += `🔸 CRYSTALLINE CONFLICT\n`;
        responseMessage += `   Wins:   ${results.crystallineConflict.wins.toLocaleString()} matches\n`;
        responseMessage += `   Losses: ${results.crystallineConflict.losses.toLocaleString()} matches\n\n`;
        
        responseMessage += `🔸 FRONTLINE\n`;
        responseMessage += `   1st Place: ${results.frontline.wins.toLocaleString()} matches\n`;
        responseMessage += `   2nd Place: ${results.frontline.secondPlace.toLocaleString()} matches\n`;
        responseMessage += `   3rd Place: ${results.frontline.losses.toLocaleString()} matches\n\n`;
        
        responseMessage += `🔸 FRONTLINE (Roulette with Daily Bonus)\n`;
        responseMessage += `   1st Place: ${results.frontlineDaily.wins.toLocaleString()} matches\n`;
        responseMessage += `   2nd Place: ${results.frontlineDaily.secondPlace.toLocaleString()} matches\n`;
        responseMessage += `   3rd Place: ${results.frontlineDaily.losses.toLocaleString()} matches\n\n`;
        
        responseMessage += `🔸 RIVAL WINGS\n`;
        responseMessage += `   Wins:   ${results.rivalWings.wins.toLocaleString()} matches\n`;
        responseMessage += `   Losses: ${results.rivalWings.losses.toLocaleString()} matches\n`;
        responseMessage += `\`\`\`\n`;        

        await interaction.editReply({
            content: responseMessage,            
        });

        log(`PvP Calculator: Level ${currentLevel} → ${goalLevel}, Progress: ${currentProgress}, XP needed: ${results.expNeeded}`);

    } catch (error) {
        log(`Error in PvP calculator: ${error.message}`, 'ERROR');
        
        let errorMessage = '❌ **Error calculating PvP requirements!**\n';
        if (error.message.includes('Goal level must be higher')) {
            errorMessage += '🎯 Goal level must be higher than current level';
        } else if (error.message.includes('Current progress must be between')) {
            errorMessage += `📈 ${error.message}`;
        } else if (error.message.includes('level must be between')) {
            errorMessage += '📊 PvP levels must be between 1 and 40';
        } else {
            errorMessage += '🔧 Please check your input values and try again';
        }

        await interaction.editReply({
            content: errorMessage
        });
    }
}


// Dice roll function with animation
async function rollDice(interaction, sides = 6, count = 1) {
    const diceEmojis = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const animationFrames = ['🎲', '🎯', '⭐', '✨', '💫', '🌟'];
    
    try {        
        await interaction.reply({
            content: `🎲 Rolling ${count} ${sides}-sided dice... ${animationFrames[0]}`,
            ephemeral: true
        });
        
        for (let frame = 1; frame < animationFrames.length; frame++) {
            await new Promise(resolve => setTimeout(resolve, 300)); // 300ms delay
            await interaction.editReply({
                content: `🎲 Rolling ${count} ${sides}-sided dice... ${animationFrames[frame]}`
            });
        }

        // any lower than 300 and bot will behave funky or message will be jumbled somehow
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const results = [];
        let total = 0;
        
        for (let i = 0; i < count; i++) {
            const roll = Math.floor(Math.random() * sides) + 1;
            results.push(roll);
            total += roll;
        }
        
        let resultMessage = `🎲 **Dice Roll Results!** 🎲\n`;
        
        if (count === 1) {
            // Single die - show emoji if it's a standard 6-sided die
            if (sides === 6) {
                resultMessage += `${diceEmojis[results[0] - 1]} **You rolled: ${results[0]}**`;
            } else {
                resultMessage += `🎯 **You rolled: ${results[0]}** (d${sides})`;
            }
        } else {
            // Multiple dice
            resultMessage += `🎯 **Individual rolls:** ${results.join(', ')}\n`;
            resultMessage += `✨ **Total:** ${total}`;
            
            if (count > 1) {
                const average = (total / count).toFixed(1);
                resultMessage += `\n📊 **Average:** ${average}`;
            }
        }

        // vanity results, add more for fun
        if (sides === 6) {
            if (results.includes(6)) {
                resultMessage += `\n🌟 *Nice! You got a 6!*`;
            }
            if (results.includes(1)) {
                resultMessage += `\n😅 *Ouch, a 1...*`;
            }
            if (count > 1 && results.every(r => r === 6)) {
                resultMessage += `\n🎉 **AMAZING! ALL SIXES!** 🎉`;
            }
            if (count > 1 && results.every(r => r === 1)) {
                resultMessage += `\n💀 *Yikes... all ones. Better luck next time!*`;
            }
        }     

        
        await interaction.editReply({
            content: resultMessage,
            
        });

        log(`Dice roll: ${count}d${sides} = ${results.join(', ')} (total: ${total})`);

    } catch (error) {
        log(`Error in dice roll: ${error.message}`, 'ERROR');
        await interaction.editReply({
            content: '❌ Sorry, something went wrong with the dice roll!'
        });
    }
}


//debug function to show the list of active events in redis
async function listActiveEvents(interaction) {
    const eventIds = await redis.hkeys('events');
    if (eventIds.length === 0) {
        return interaction.reply({ content: 'No active events found.', ephemeral: true });
    }
    let message = '**Active Events:**\n';
    for (const eventId of eventIds) {
        const event = await getEventFromRedis(eventId);
        message += `• **ID:** ${event.id}\n  **Type:** ${event.type}\n  **Date:** <t:${Math.floor(new Date(event.date).getTime() / 1000)}:F>\n  **Organizer:** <@${event.organizer}>\n  **Participants:** ${event.participants.length}\n\n`;
    }
    return interaction.reply({ content: message, ephemeral: true });
}

//function to purge all events from redis (for testing)
async function purgeAllEvents() {
    const eventIds = await redis.hkeys('events');
    for (const eventId of eventIds) {
        await deleteEventFromRedis(eventId);
        await cancelEventReminders(eventId);
    }
    console.log('All events purged.');
} 

// Slash commands
const commands = [    
    new SlashCommandBuilder()
        .setName('roll')
        .setDescription('Roll a dice with animation!')
        .addIntegerOption(option =>
            option.setName('sides')
                .setDescription('Number of sides on the dice (default: 6)')
                .setMinValue(2)
                .setMaxValue(100)
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('count')
                .setDescription('Number of dice to roll (default: 1)')
                .setMinValue(1)
                .setMaxValue(10)
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('pvp')
        .setDescription('Calculate PvP Malmstone requirements')
        .addIntegerOption(option =>
            option.setName('current_level')
                .setDescription('Your current PvP level (1-40)')
                .setMinValue(1)
                .setMaxValue(40)
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('goal_level')
                .setDescription('Your target PvP level (1-40)')
                .setMinValue(1)
                .setMaxValue(40)
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('current_progress')
                .setDescription('Your current XP progress in current level (default: 0)')
                .setMinValue(0)
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('create-event')
  .setDescription('Create a new FF14 event')
  .addStringOption(option =>
    option.setName('type')
      .setDescription('Type of event')
      .setRequired(true)
      .addChoices(...EVENT_TYPES)
  )
  .addStringOption(option =>
    option.setName('datetime')
      .setDescription('Date and time (YYYY-MM-DD HH:MM UTC)')
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName('description')
      .setDescription('Additional event description (optional)')
      .setRequired(false)
  ),
    new SlashCommandBuilder()
        .setName('list-events')
        .setDescription('List all active events (debug)'),        
    new SlashCommandBuilder()
        .setName('purge-events')
        .setDescription('Purge all events (debug)'),
];

// OK so this section about upload and config loading is old and deprecated. it was from another function from a personal project
// but I left it in because I might want to add more functionality later
// and it might be useful for reference.
// It does not affect current bot functionality. 
client.once('ready', async () => {
    log(`Logged in as ${client.user.tag}`);
    
    // Create uploads directory if it doesn't exist
    try {
        await fs.mkdir('uploads', { recursive: true });
    } catch (error) {
        // Directory already exists
    }
    
    // Load configuration
    await loadConfig();
    
    // Register slash commands
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        log('Slash commands registered successfully');
    } catch (error) {
        log(`Error registering slash commands: ${error.message}`, 'ERROR');
    }  
    
    
    log('Bot started successfully');
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    
    const { commandName } = interaction;
    
    try {
        switch (commandName) {            
            case 'roll':
                const sides = interaction.options.getInteger('sides') || 6;
                const count = interaction.options.getInteger('count') || 1;
                log(`Dice roll command: ${count}d${sides}`);                
                await rollDice(interaction, sides, count);
                break;
            case 'pvp':
                const clvl = interaction.options.getInteger('current_level');
                const glvl = interaction.options.getInteger('goal_level');
                const cprog = interaction.options.getInteger('current_progress');
                log('Getting variables from interaction');
                await handlePvPCalculator(interaction, clvl, glvl, cprog);
                break;
            case 'create-event':
                await handleCreateEvent(interaction);
                break;
            case 'list-events':
                if (!AUTHORIZED_USERS.includes(interaction.user.id)) {
                    return interaction.reply({ content: '❌ You are not authorized to use this command.', ephemeral: true });
                }
                await listActiveEvents(interaction);                
                break;
            case 'purge-events':
                if (!AUTHORIZED_USERS.includes(interaction.user.id)) {
                    return interaction.reply({ content: '❌ You are not authorized to use this command.', ephemeral: true });
                }
                await purgeAllEvents();
                await interaction.reply({ content: '✅ All events purged (debug).', ephemeral: true });
                break;    
        }
    } catch (error) {
        log(`Error executing command ${commandName}: ${error.message}`, 'ERROR');
        await interaction.reply('An error occurred while executing the command.');
    }
});

// Separate handler for button interactions
client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        try {
            await handleButtonInteraction(interaction);
        } catch (error) {
            log(`Error handling button interaction: ${error.message}`, 'ERROR');
            await interaction.reply({ content: 'An error occurred while handling the button interaction.', ephemeral: true });
        }
    }
});



// Start the Discord bot
if (TOKEN) {
    client.login(TOKEN);
} else {
    log('No Discord token provided. Please set the DISCORD_TOKEN environment variable.', 'ERROR');
}