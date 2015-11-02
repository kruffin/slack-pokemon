var pokeapi = require('./poke-api.js');
var stateMachine = require('./state-machine.js');
var moves = require('./move-types.js');
var Q = require('q');

module.exports = {}

/*
 * Return a text string when the battle starts.
 * Stores the player's Slack username and what channel the battle is in,
 * and chooses a Pokemon for the NPC from the original 151.
 */
module.exports.startBattle = function(slackData) {
  var textString = "OK {name}, I'll battle you! ".replace("{name}", slackData.user_name);
  var dex_no = Math.ceil(Math.random() * 151);

  var chooseNpcPokemon = function() {
    return module.exports.choosePokemon(slackData.user_name, 'npc', dex_no);
  },

  createNpcAnnouncement = function(pkmnChoice){
    return {
      text: textString + '\n' + pkmnChoice.text,
      spriteUrl: pkmnChoice.spriteUrl
    }
  };

  return stateMachine.newBattle(slackData.user_name, slackData.channel_name)
  .then( chooseNpcPokemon )
  .then( createNpcAnnouncement )
}

/*
 * Return a text string when the user chooses a Pokemon.
 * Fetch the pokemon from the API, choose 4 random moves, write them to REDIS,
 * and then return a message stating the pokemon, its HP, and its moves.
 */
module.exports.choosePokemon = function(playerName, chooserName, pokemon) {
  var textString = "{chooseMessage} {pkmnn}. It has {hp} HP, and knows {moves}";
  var movePromises = [];

  return pokeapi.getPokemon(pokemon).then(function(pkmndata){
    var choosePokemon = function() {
      return stateMachine.choosePokemon(playerName, chooserName, pkmndata);
    },

    getMoveSet = function() {
      return getRandomMoveSet(pkmndata.moves, movePromises, playerName, chooserName, pkmndata.name);
    },

    setTextString = function(moveString){
      var displayName = (chooserName === 'npc') ? 'I choose' : chooserName + ' chooses';

      textString = textString.replace("{chooseMessage}", displayName);
      textString = textString.replace("{pkmnn}", pkmndata.name);
      textString = textString.replace("{hp}", pkmndata.hp);
      textString = textString.replace("{moves}", moveString);

      var stringy = "" + pkmndata.pkdx_id;
      if (stringy.length == 1) {
        stringy = "00" + stringy;
      } else if (stringy.length == 2) {
        stringy = "0" + stringy;
      }
      return {
        text: textString,
        spriteUrl: "http://sprites.pokecheck.org/i/"+stringy+".gif"
      }
    };

    return Q.allSettled(movePromises)
    .then( choosePokemon )
    .then( getMoveSet )
    .then( setTextString );
  });
}

/*
 * When the user uses a move, calculate the results of the user's turn,
 * then the NPC's turn. If either one of them ends the battle, don't show
 * the other result.
 */
module.exports.doTurn = function(moveName, slackData) {
  var results = [];
  var doNpcMove = function() {
    return useMove(null, slackData.user_name, 'npc', slackData.user_name, true)
  },

  doUserMove = function() {
    return useMove(moveName, slackData.user_name, slackData.user_name, 'npc', false)
  },

  saveResult = function(result) {
    results.push(result)
  },

  printResults = function(){
    if(~results.indexOf('You Beat Me!') && ~results.indexOf('You Lost!')) {
      return 'It\'s a draw!';
    } else if(~results.indexOf('You Beat Me!')) {
      return 'You Beat Me!';
    } else if(~results.indexOf('You Lost!')) {
      return 'You Lost!';
    } else {
      return results[1] + "\n" + results[0];
    }
  };

  //TODO: Choose who goes first based on speed
  return doNpcMove()
  .then( saveResult )
  .then( doUserMove )
  .then( saveResult )
  .then( printResults )
}

/*
 * Return a text string when the command doesn't match defined commands.
 */
module.exports.unrecognizedCommand = function(commandsArray) {
  var textString = "I don't recognize the command _{cmd}_ .";
  //get rid of the 'pkmn'
  commandsArray.shift();
  textString = textString.replace("{cmd}", commandsArray.join(" "));
  return Q.fcall(function(){ return textString; });
}

module.exports.endBattle = function(slackData) {
  return stateMachine.endBattle(slackData.user_name);
}


////////////////////////////////
//        Private Methods     //
////////////////////////////////

function getRandomMoveSet(moveList, movePromises, playerName, initPlayerName, pokemonName) {
  var textString = '';
  var moves = shuffle(moveList);

  for(var i = 0; i < 4; i++) {
    movePromises.push(
      pokeapi.getMove("http://pokeapi.co"+moves[i].resource_uri)
      .then(function(data){
        stateMachine.addMove(data, playerName, initPlayerName, pokemonName);
      })
    )
    //format: "vine whip, leer, solar beam, and tackle."
    if(i < 3) {
      textString += moves[i].name;
      textString += ", ";
    } else {
      textString += "and ";
      textString += moves[i].name;
      textString += ".";
    }
  }

  return textString;
}

var effectivenessMessage = function(mult) {
  switch(mult) {
    case 0:
      return "It doesn't have an effect. ";
      break;
    case 0.5:
    case 0.25:
      return "It's not very effective... ";
      break;
    case 1:
      return " ";
      break;
    case 2:
    case 4:
      return "It's super effective! ";
      break;
    default:
      return " ";
      break;
  }
}

/*
 */
var useMove = function(moveName, playerName, trainerName, otherName, isOpponentMove) {
  var textString = "{txtPrep1} used {mvname}! {effctv}";
  var textStringDmg = "It did {dmg} damage, leaving {txtPrep2} with {hp}HP!";
  var moveData;
  var multiplier;
  var totalDamage;

  var getMoves = function() {
    return stateMachine.getActivePokemonAllowedMoves(playerName, trainerName);
  },

  getMove = function(moves){
    if(moveName === null) {
      var rand = Math.floor(Math.random() * 4);
      textString = textString.replace("{mvname}", moves[rand]);
      return stateMachine.getSingleMove(moves[rand]);
    } else if(moves.indexOf(moveName) !== -1) {
      textString = textString.replace("{mvname}", moveName);
      return stateMachine.getSingleMove(moveName);
    } else {
      throw new Error("Your pokemon doesn't know that move. Your Moves: " + moves.toString());
    }
  },

  getPokemonType = function(_moveData){
    moveData = _moveData;
    return stateMachine.getActivePokemonTypes(playerName, otherName)
  },

  getAttackMultiplier = function(types){
    return pokeapi.getAttackMultiplier(moveData.type, types[0], types[1])
  },

  doDamage = function(multiplier){
    totalDamage = Math.ceil( (moveData.power / 5) * multiplier )
    return stateMachine.doDamageToActivePokemon(playerName, otherName, totalDamage)
  },

  formOutcomeText = function(hpRemaining){
    if(parseInt(hpRemaining, 10) <= 0) {
      return stateMachine.endBattle(playerName)
      .then(function(){
        var outcomeMsg = (isOpponentMove) ? 'You Lost!' : 'You Beat Me!';
        return outcomeMsg;
      })
    }
    var txtPrep1 = (isOpponentMove) ? 'I' : 'You';
    textString = textString.replace("{txtPrep1}", txtPrep1);
    textString = textString.replace("{effctv}", effectivenessMessage(multiplier));

    var txtPrep2 = (isOpponentMove) ? 'you' : 'me';
    textStringDmg = textStringDmg.replace("{txtPrep2}", txtPrep2);
    textStringDmg = textStringDmg.replace("{dmg}", totalDamage);
    textStringDmg = textStringDmg.replace("{hp}", hpRemaining);

    if(multiplier == 0)
      return textString;
    return textString + textStringDmg;
  }

  return getMoves()
  .then( getMove )
  .then( getPokemonType )
  .then( getAttackMultiplier )
  .then( doDamage )
  .then( formOutcomeText )
}

//+ Jonas Raoni Soares Silva
//@ http://jsfromhell.com/array/shuffle [v1.0]
function shuffle(o){ //v1.0
  for(var j, x, i = o.length; i; j = Math.floor(Math.random() * i), x = o[--i], o[i] = o[j], o[j] = x);
  return o;
};
