require('dotenv').config()

const { Client, MessageEmbed } = require('discord.js')

const { Sequelize, DataTypes, Op } = require('sequelize')
const client = new Client()

const sequelize = new Sequelize(process.env.DATABASE_URI)

const emojiRegex = /<:.*:([0-9]{16,18})>/

const matchModel = sequelize.define('match', {
  serverId: DataTypes.STRING,
  name: DataTypes.STRING,
  winnerParticipantId: DataTypes.INTEGER,
  messageId: DataTypes.STRING,
  channelId: DataTypes.STRING
})

const teamModel = sequelize.define('team', {
  id: {
    primaryKey: true,
    autoIncrement: true,
    type: DataTypes.INTEGER
  },
  serverId: {
    primaryKey: true,
    type: DataTypes.STRING
  },
  emojiId: {
    primaryKey: true,
    type: DataTypes.STRING
  },
  name: DataTypes.STRING
})

const matchParticipantModel = sequelize.define('matchParticipant')

const choiceModel = sequelize.define('choice', {
  userId: {
    type: DataTypes.STRING,
    primaryKey: true
  },
  matchId: {
    type: DataTypes.INTEGER,
    primaryKey: true
  }
})

matchModel.hasMany(choiceModel)
choiceModel.belongsTo(matchModel)
choiceModel.belongsTo(matchParticipantModel)

matchModel.hasMany(matchParticipantModel)
matchParticipantModel.belongsTo(matchModel)

matchParticipantModel.belongsTo(teamModel)
teamModel.hasMany(matchParticipantModel)

sequelize.sync()

const prefix = process.env.PREFIX || ','

client.on('message', async message => {
  if (!message.content.startsWith(prefix)) return

  const command = message.content.split(/ +/g)[0].slice(prefix.length)
  const args = message.content.split(/ +/g).slice(1)

  switch (command) {
    case 'addteam':
      if (!message.member.hasPermission('MANAGE_GUILD')) return message.reply('sem permissão')
      if (!args[0]) return message.reply('informe o ID do emoji')
      if (!args[1]) return message.reply('informe o nome do time')
      let emojiId = args[0]
      if (emojiRegex.test(args[0])) {
        emojiId = args[0].match(emojiRegex)[1]
        console.log(emojiId)
      }
      await teamModel.create({
        serverId: message.guild.id,
        emojiId: emojiId,
        name: args.slice(1).join(' ')
      })
      message.reply('time criado')
      break
    case 'teams':
      const teams = await teamModel.findAll({
        where: {
          serverId: message.guild.id
        }
      })
      message.reply(
        new MessageEmbed()
          .setTitle('Teams')
          .setDescription(
            teams.map(t => {
              const emoji = client.emojis.cache.get(t.getDataValue('emojiId'))
              return `${emoji.toString()} ${t.getDataValue('name')}`
            })
          )
      )
      break
    case 'addmatch':
      if (!message.member.hasPermission('MANAGE_GUILD')) return message.reply('sem permissão')
      if (!args[0]) return message.reply('informe o primeiro time.')
      if (!args[1]) return message.reply('informe o segundo time.')
      if (!args[2]) return message.reply('informe o nome da partida')
      const matchName = args.slice(2).join(' ')
      
      const team1EmojiId = emojiRegex.test(args[0]) ? args[0].match(emojiRegex)[1] : args[0]
      const team2EmojiId = emojiRegex.test(args[1]) ? args[1].match(emojiRegex)[1] : args[1]

      const teamResults = await teamModel.findAndCountAll({
        where: {
          emojiId: [ team1EmojiId, team2EmojiId ]
        }
      })

      if (teamResults.count !== 2) return message.reply('times não encontrados')

      message.delete()

      const match = await matchModel.create({
        serverId: message.guild.id,
        name: matchName
      })

      await matchParticipantModel.bulkCreate(teamResults.rows.map(r => ({
        matchId: match.getDataValue('id'),
        teamId: r.getDataValue('id')
      })))

      const matchMessage = await message.channel.send(
        new MessageEmbed()
          .setTitle(match.getDataValue('name'))
          .setDescription(
            teamResults.rows.map(t => {
              const emoji = client.emojis.cache.get(t.getDataValue('emojiId'))
              return `${emoji.toString()} **${t.getDataValue('name')}**`
            })
          )
          .setFooter(`#${match.getDataValue('id')}`)
      )

      teamResults.rows.forEach(t => {
        const emoji = client.emojis.cache.get(t.getDataValue('emojiId'))
        matchMessage.react(emoji)
      })

      matchModel.update({
        messageId: matchMessage.id,
        channelId: matchMessage.channel.id
      }, {
        where: {
          id: match.getDataValue('id')
        }
      })
      break
    case 'countchoices':
      if (!message.member.hasPermission('MANAGE_GUILD')) return message.reply('sem permissão')
      if (!args[0]) return message.reply('informe o ID da partida.')
      const matchResponse = await matchModel.findOne({
        where: {
          id: args[0],
          serverId: message.guild.id
        }
      })
      
      message.channel.startTyping()

      const participants = await matchParticipantModel.findAll({
        where: {
          matchId: matchResponse.getDataValue('id')
        },
        include: teamModel
      })

      const matchChannel = await message.guild.channels.cache.get(matchResponse.getDataValue('channelId'))
      if (!matchChannel) return message.reply('match channel not found')

      const countingMatchMessage = await matchChannel.messages.fetch(matchResponse.getDataValue('messageId'))
      if (!matchChannel) return message.reply('match message not found')

      const matchReactions = countingMatchMessage.reactions.cache

      const choices = new Map()
      for (const [id, r] of matchReactions) {
        const users = await fetchUsers(r.users)
        for (const u of users) {
          if (choices.has(u.id)) {
            choices.delete(u.id)
          } else {
            choices.set(u.id, participants.find(p => p.team.getDataValue('emojiId') === r.emoji.id).getDataValue('id'))
          }
        }
      }

      await choiceModel.destroy({
        where: {
          matchId: args[0]
        }
      })

      const entriesCreate = []
      choices.forEach((choice, userId) => {
        console.log(userId, choice)
        entriesCreate.push({
          matchId: args[0],
          matchParticipantId: choice,
          userId
        })
      })

      await choiceModel.bulkCreate(entriesCreate)
      message.channel.stopTyping()
      message.reply(`escolhas computadas para a partida #${matchResponse.getDataValue('id')}`)
      break
    case 'choices':
      const userChoices = await choiceModel.findAll({
        where: {
          userId: message.member.user.id,
        },
        include: [{
          association: 'matchParticipant',
          required: true,
          include: [{
            association: 'team',
            required: true
          }]
        }, {
          association: 'match',
          required: true
        }],
        order: [['match', 'createdAt', 'DESC']]
      })
      message.channel.send(
        new MessageEmbed()
          .setTitle(`Escolhas de ${message.member.displayName}`)
          .setDescription(
            userChoices.map(u => {
              const hasWinner = !!u.match.winnerParticipantId
              const choseWinner = u.matchParticipantId === u.match.winnerParticipantId
              return `${hasWinner ? (choseWinner ? '✅' : '❌') : '⚔️'} ${client.emojis.cache.get(u.toJSON().matchParticipant.team.emojiId)} ${u.toJSON().match.name}`
            })
          )
      )
      break
    case 'setwinner':
      if (!message.member.hasPermission('MANAGE_GUILD')) return message.reply('sem permissão')
      if (!args[0]) return message.reply('informe o número da partida.')
      if (!args[1]) return message.reply('informe o emoji do time.')
      
      const winnerEmojiId = emojiRegex.test(args[1]) ? args[1].match(emojiRegex)[1] : args[1]

      const currentMatch = await matchModel.findOne({
        where: {
          id: args[0]
        },
        include: {
          model: matchParticipantModel,
          include: teamModel
        }
      })

      if (!currentMatch) return message.reply('partida não encontrada')

      const winnerParticipant = currentMatch.toJSON().matchParticipants.find(mp => mp.team.emojiId === winnerEmojiId)
      
      console.log(winnerParticipant)
      if (!winnerParticipant) return message.reply('nenhum participante com esse emoji encontrado')

      await matchModel.update({
        winnerParticipantId: winnerParticipant.id
      }, {
        where: {
          id: currentMatch.id
        }
      })

      message.reply(`vencedor da partida ${currentMatch.id} definido como **${winnerParticipant.team.name}**`)
      break
    case 'ranking':
      const correctChoices = await choiceModel.count({
        where: {
          matchParticipantId: {
            [Op.eq]: sequelize.col('match.winnerParticipantId')
          }
        },
        include: [{
          association: 'matchParticipant',
          required: true
        }, {
          association: 'match',
          required: true
        }],
        group: [ sequelize.col('userId') ],
        order: [['count', 'DESC']],
        limit: 10
      })
      const emojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']
      message.channel.send(
        new MessageEmbed()
          .setTitle('Ranking')
          .setDescription(correctChoices.map((c, i) => `${emojis[i]} ${client.users.cache.get(c.userId)} ${c.count} pontos`))
      )
      break
  }
})

async function fetchUsers (manager, data = [], after = '0') {
  const users = await manager.fetch({ limit: 100, after })
  users.forEach(u => {
    data.push(u)
  })
  console.log(data.length)
  if (users.size > 0) return fetchUsers(manager, data, users.lastKey())
  return data
}

client.on('ready', () => {
  console.log('Logado como', client.user.tag)
})

client.login(process.env.DISCORD_TOKEN)