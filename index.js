// Critical for Express itself
const express = require("express");
const app = express();
const fs = require('fs');

// Ensure API Keys and Confidential Data don't get published to Github
const config = require("./private/keys.json");

const options = {
  key: fs.readFileSync(config.keyPath),
  cert: fs.readFileSync(config.certPath)
};

// require('./server.js');

// Modules used to facilitate data transfer and storage
const cookieParser = require("cookie-parser");
app.use(cookieParser());
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const axios = require("axios");

const server = require("https").createServer(options, app);
// TODO: Double check what CORS policy will mean for our app.
const io = require("socket.io")(server, { cors: { origin: "*" } });

// Setting up a helper Wrapper library to make the Steam API much easier to use
const steamWrapper = require("steam-js-api");
steamWrapper.setKey(config.steamKey);

// Necessary for Steam Oauth
const SteamAuth = require("node-steam-openid");

// Setup for Steam Oauth
const steam = new SteamAuth({
  // TODO: Eventually this will be set to the proper Domain name.
  realm: config.url,
  returnUrl: config.url + "/auth/steam/authenticate",
  apiKey: config.steamKey,
});

// Setup for keeping track of Users temporary data.
const session = require("express-session");
const { types } = require("util");
const { parse } = require("path");
app.use(
  session({
    secret: config.sessionSecret,
    resave: true,
    saveUninitialized: true,
  }),
  bodyParser.urlencoded({ extended: true }),
  bodyParser.json({ extended: true })
);

// Tell Express which Templating Engine we're using
app.set("view engine", "ejs");
// Specify the Folder for Statics
app.use(express.static("public"));
// Need this line to allow Express to parse values sent by POST forms
app.use(express.urlencoded({ extended: true }));
// Setup our SQLite DB for our game information.
const db = require("better-sqlite3")(`./private/games.db`);

// ================== RUNTIME VARIABLES ==================

// TODO: Consolidate the two room structs (this & socketRooms) so we don't use extra memory.
let existingRooms = [];
// Sockets used for members of the same room
function Room(roomNumber, roomMembers) {
  this.roomNumber = roomNumber;
  this.roomMembers = roomMembers;
  this.roomSize = 0;
}

// Hard coded users for testing
let mainTestingRoom = new Room(`99999`, [[`76561198016716226`, `TidalWings`, `https://avatars.steamstatic.com/de63198a51c76b3ed2dfd72e82d2ce4d666ce449_medium.jpg`]]);
let altTestingRoom = new Room(`11111`, [[`76561199516233321`, `drslurpeemd`, `https://avatars.steamstatic.com/b9fa08a1e25a9dadaebbab031b6b2974502416fa_medium.jpg`]]);
let socketRooms = [];
socketRooms.push(mainTestingRoom);
socketRooms.push(altTestingRoom);
existingRooms.push(`99999`);
existingRooms.push(`11111`);

// ================== FUNCTIONS ==================

// Fetches details of game using its id
async function fetchTags(gameID) {
  const url = `https://steamspy.com/api.php?request=appdetails&appid=${gameID}`;
  const response = await fetch(url);
  const result = await response.json();
  const tags = Object.keys(result.tags).join(",");
  return tags;
}

/**
 * deleteRoom will only be run on situations where the user is the LAST user in a room. It will go and delete the entire element from the array.
 * @param {Number} roomNumber the number of the room to be deleted 
 */
function deleteRoom(roomNumber) {
    let indexOfRoom = -1;

    for (let i = 0; i < socketRooms.length; i++) {
        const curRoomNum = socketRooms[i].roomNumber;
        if (curRoomNum == roomNumber) {
            indexOfRoom = i;
        }
    }

    // Ensuring we ACTUALLY only delete the room if it's found
    if (indexOfRoom != -1) {
        socketRooms.splice(indexOfRoom, 1);
    }
}

/**
 * Removes user from the room
 * @param {*} roomNumber 
 * @param {*} userID 
 */
function deleteUserFromRoom(roomNumber, userID) {
    let indexOfRoom = -1;

    for (let i = 0; i < socketRooms.length; i++) {
        const curRoomNum = socketRooms[i].roomNumber;
        if (curRoomNum == roomNumber) {
            indexOfRoom = i;
        }
    }

    // Ensuring we ACTUALLY only delete the room if it's found
    if (indexOfRoom != -1) {
        let indexOfUser = -1;
        
        let curRoomMembers = socketRooms[indexOfRoom].roomMembers;
        for (let j = 0; j < curRoomMembers.length; j++) {
            if (curRoomMembers[j][0] == userID) {
                indexOfUser = j;
            }
        }

        if (indexOfUser != -1) {
            socketRooms[indexOfRoom].roomMembers.splice(indexOfUser, 1);
        }
    }
}

// TODO: Make this dynamically generate a YYYY-MM-DD format
function generateDate() {
  return `2023-07-20`;
}

// Used to get data that was not previously fetched using the game id
async function fetchGenresPrices(gameID) {
  // Then Steam's API for majority of the data. From this we want the "categories" and pricing of each game.
  const steamURL = `https://store.steampowered.com/api/appdetails?appids=${gameID}&l=en`;
  const response2 = await fetch(steamURL);
  const result2 = await response2.json();
  let initial_price = 0;
  let final_price = 0;
  let genre = ``;

  if (result2[`${gameID}`].success == true) {
    // ensures no de-listed games
    // Getting the price of the games
    // TODO: Certain games like GTA V don't even have price_overview but a convoluted layout, so there needs to be more searching for those edge cases.
    let priceOverview = result2[`${gameID}`].data.price_overview;
    if (typeof priceOverview != `undefined`) {
      final_price = priceOverview.final_formatted; // final
      initial_price = priceOverview.initial_formatted; // initial
      final_price = parseFloat(final_price.replace("$", ""));
      initial_price = parseFloat(initial_price.replace("$", ""));
    }
    // Getting the "categories" of the game
    let categories = result2[`${gameID}`].data.categories;
    let descriptions = ``;
    if (typeof categories != `undefined`) {
      descriptions = categories.map((category) => category.description);
      genre = descriptions.join();
    } else {
      genre = `Single-player`;
    }
  } else {
    genre = `Single-player`;
    initial_price = 0;
    final_price = 0;
  }

  return [genre, initial_price, final_price];
}

// TODO: Finish functionality
function computeDateDiff(dateToCompare) {
  const curDate = generateDate();

  // TODO: Utilize current date & the to compare one and see how many days "past expiration" it is. If it's greater than or equal to 3, return TRUE otherwise return FALSE
  return false; // placeholder return for now.
}

// Checks our database to see if we've got the game and then checks if the user is associated with said game
async function checkGames(steamID) {
  // First we'll fetch the list of owned games per the users steamID.
  // An API function that will set gameCount and gameInfo to the total count
  // of a users games and aan array of their games respectively.
  await steamWrapper
    .getOwnedGames(steamID, null, true)
    .then((result) => {
      gameCount = result.data.count;
      gameInfo = result.data.games;
    })
    .catch(console.error);

  // We iterate through the users' games using the data from the above function
  for (let curGame = 0; curGame < gameCount; curGame++) {
    const gameName = gameInfo[curGame].name;
    const gamePic = gameInfo[curGame].url_store_header;
    const gameURL = gameInfo[curGame].url_store;
    const gameID = gameInfo[curGame].appID;

    // Variables that are et later with API fetches
    let tags = "";
    let genre = "";
    let final_price = 0;
    let initial_price = 0;

    // FIRST we query our database to see if we HAVE the game or not
    const localGame = db
      .prepare("SELECT * FROM Games WHERE gameID = ?")
      .get(`${gameID}`);

    // Then check if the user has the local game registered in the database
    const userPotentialGame = db
      .prepare("SELECT * FROM Users WHERE userID = ? AND gameID = ?")
      .get([`${steamID}`, `${gameID}`]);

    // if the game is located we check if the user has the game in their database
    if (localGame) {
      // IFF >= 3 days old then re-query
      if (computeDateDiff(localGame.age)) {
        // TODO:
      }
      // If they don't have the game in their table we add it to their database else do nothing
      if (!userPotentialGame) {
        db.prepare(`INSERT INTO Users (userID, gameID) VALUES (?, ?)`).run(
          steamID,
          `${gameID}`
        );
      }
    } else {
      // Case if the game is not located in the database
      // We query game and add it to the Games table along with the users personal table
      tags = await fetchTags(gameID);
      let temp = await fetchGenresPrices(gameID);
      genre = temp[0];
      initial_price = temp[1];
      final_price = temp[2];
      let is_multiplayer = 1;
      let age = generateDate();

      // If its single player
      if (!genre.includes(`Multi-player`)) {
        is_multiplayer = 0;
      }

      console.log(`Added ${gameName} - ${gameID}!`);
      db.prepare(
        `INSERT INTO Games(gameID, name, genre, tags, age, price, initial_price, is_multiplayer, header_image, store_url) VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        `${gameID}`,
        gameName,
        genre,
        tags,
        age,
        final_price,
        initial_price,
        `${is_multiplayer}`,
        gamePic,
        gameURL
      );

      db.prepare(`INSERT INTO Users (userID, gameID) VALUES (?,?)`).run(
        steamID,
        `${gameID}`
      );
    }
  }
}

/**
 * Given tags to parse and tags to ignore, builds and maintains an array of tags to return.
 * @param {String} inputTags are the incoming tags (in this format `FPS,Action,Strategy` etc.)
 * @param {Array} existingTags are tags that SHOULDN'T BE returned because they were previously added. In a array format.
 * @returns {Array} toReturn curated tag array.
 */
function maintainTags(inputTags, existingTags) {
  const splitTags = inputTags.split(",");
  let toReturn = existingTags;

  splitTags.forEach((tag) => {
    if (!toReturn.includes(tag)) {
      toReturn.push(tag);
    }
  });

  return toReturn;
}

// ================== ROUTES ==================

// corresponds to page.com
app.get("/", (req, res) => {
  res.render("index");
});

// Renders our privacy policy
app.get("/privacy-policy", (req, res) => {
  res.render("privacy-policy");
});

// Redirects user to steam login page
app.get("/auth/steam", async (req, res) => {
  const redirectUrl = await steam.getRedirectUrl();
  return res.redirect(redirectUrl);
});

// Gets user information and renders the rooms page
app.get("/auth/steam/authenticate", async (req, res) => {
  try {
    const user = await steam.authenticate(req);

    // TODO: Check that this cookie storage method is best practices.
    res.cookie("steamID", user["steamid"]);
    res.cookie("username", user["username"]);
    res.cookie("avatar", user["avatar"]["medium"]);

    // DEBUG: Checking who is logged in via Backend
    console.log(`${user["username"]} has logged in!`);

    res.render("room-choice");
  } catch (error) {
    console.error(`ERROR: Couldn't Fetch! ${error}`);
  }
});

//Used in case users want to login through their steam id
app.get("/alt-login", (req, res) => {
  res.render("alt-login");
});

// Users get shown the CREATE or JOIN room buttons. Here they'll start the process of generating a Room Number and allowing others to join them.
app.get("/room-choice", (req, res) => {
  res.render("room-choice");
});

//Passes host role and creates a unique room
app.post("/room-choice", async (req, res) => {
  let roomNumber = Math.floor(Math.random() * 90000) + 10000;
  roomNumber = roomNumber.toString();
  // Ensures that room numbers are random and unique so we don't have colliding room IDs.
  while (existingRooms.includes(roomNumber)) {
    roomNumber = Math.floor(Math.random() * 90000) + 10000;
    roomNumber = roomNumber.toString();
  }

  // Add our now guaranteed unique room to the existing rooms & also add the number to the users cookies.
  existingRooms.push(roomNumber);
  res.cookie("roomNumber", roomNumber);

  // Render the next page for the Host now with the number on their page.
  res.redirect(
    "empty-room",
    {
      role: req.body.role,
      roomNumber: this.roomNumber,
      url: config.url,
    },
    303
  );
});

// Renders join room page with all the currently existing rooms
app.get("/join-room", (req, res) => {
  res.render("join-room", { existingRooms: existingRooms });
});

// Gets data from front end and then adds user to the room if the code is valid
app.post("/join-room", async (req, res) => {
  await checkGames(req.cookies.steamID);
  let potentialRoomNum = req.body.roomnum;

  if (existingRooms.includes(potentialRoomNum)) {
    res.cookie("roomNumber", potentialRoomNum);
    res.render("empty-room", { roomNumber: potentialRoomNum, url: config.url});
  } else {
    res.render("join-room", { existingRooms: existingRooms});
  }
});

// Renders list page
app.get("/list", async (req, res) => {

  res.render("list", { url: config.url});
});

// TODO: Ensure that regardless of the proper routing, that all pages validate and ensure they have the data they need (e.g. empty-room will redirect the users to create/join room if they DONT have a Room Number in their cookies).
// Renders the room with its users
app.get("/empty-room", async (req, res) => {
    
  await checkGames(req.cookies.steamID);

  res.render("empty-room", {
    roomNumber: req.cookies.roomNumber,
    url: config.url
  });
});

//Used for alt login
app.post("/alt-login", async (req, res) => {
  try {
    let steamID = req.body.userId;
    console.log("Getting user information...");
    const response = await axios.get(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${config.steamKey}&steamids=${steamID}`
    );
    //const players = response.data && response.data.response && response.data.response.players;
    let user = response.data.response.players;

    let username = user[0].personaname;
    let profileImg = user[0].avatarmedium;

    res.cookie("steamID", steamID);
    res.cookie("username", username);
    res.cookie("avatar", profileImg);
    res.redirect(303, "room-choice");
  } catch {
    console.log("Could not fetch information...");
  }
});


//Socket.io used to room member data to the front end
io.on("connection", (socket) => {

  // Used to refresh the list when a user joins/leaves a room
  socket.on('generateList', (data) => {
    socket.join("room-" + data.roomNumber);
    io.sockets.in("room-" + data.roomNumber).emit("refreshList");
  });

  // Used to refresh the empty-room page when a user leaves
  socket.on('generateList2', (data) => {
    socket.join("room-" + data.roomNumber);
    io.sockets.in("room-" + data.roomNumber).emit("refreshList2");
  });

  // Used to generate room with its members
  socket.on("message", (data) => {
    // Comes from the front end; number was made in another route (room choice).
    let roomNumber = data.roomNumber;
    socket.join("room-" + roomNumber);

    let potentialRoom = socketRooms.find((x) => x.roomNumber === roomNumber);

    // Using the variable above, we can check if there IS a room or not
    if (typeof potentialRoom != "undefined") {
      // DEBUG: Checking our Logic
      console.log(`Found Room: ${roomNumber}`);
      let foundMembers = potentialRoom.roomMembers;
      // Quickly loop and check if the USER is ALREADY there DON'T update
      let hasFound = false;
      for (let i = 0; i < foundMembers.length; i++) {
        if (foundMembers[i][0] == data.steamID) {
          hasFound = true;
        }
      }

      if (hasFound == false) {
        foundMembers.push([data.steamID, data.username, data.avatar]);
        potentialRoom.roomMembers = foundMembers;
      }
    } else {
      // DEBUG: Checking our Logic
      console.log(`Room NOT Found: ${roomNumber}`);
      // Made a temp array to store the first user (HOST) and add to the array keeping track of existing socket rooms.
      let temp = new Room(roomNumber, [
        [data.steamID, data.username, data.avatar],
      ]);
      socketRooms.push(temp);
    }


    // Re-find the room again and send the output of users to the front-end
    potentialRoom = socketRooms.find((x) => x.roomNumber === roomNumber);
    roomMembers = potentialRoom.roomMembers;

    // Emits data to everyone in a room
    io.sockets.in("room-" + roomNumber).emit("otherMsg", roomMembers);
  });

  // Emits data to reroute users in a room
  socket.on("newList", (data) => {
    socket.join("room-" + data.roomNumber);
    io.sockets.in("room-" + data.roomNumber).emit("navigate");
  });

  // MAIN WORKHORSE FUNCTION. Gathers the SteamIDs of the room members and uses them to generate the massive list of shared games.
  // Sort by amount of time played and then generate shared list
  socket.on("generate", async (data) => {
    const roomNumber = data.roomNumber;
    const roomMembers = socketRooms.find(
      (x) => x.roomNumber === roomNumber
    ).roomMembers;

    // Queries all multiplayer games
    let query = `SELECT * FROM Games NATURAL JOIN Users WHERE userID = ? AND is_multiplayer = 1`;

    // Retrieve the users selected tags & reshape the SQL based on it.
    const tagSelection = data.tagSelection;
    const tagsPresent = !(tagSelection === null || tagSelection.trim() === "");
    if (tagsPresent) {
      query += ` AND tags LIKE '%${tagSelection}%'`;
    }

    // Retrieve the users selected genres & reshape the SQL based on it.
    const categorySelection = data.categorySelection;
    const categoryPresent = !(
      categorySelection === null || categorySelection.trim() === ""
    );
    if (categoryPresent) {
      query += ` AND genre LIKE '%${categorySelection}%'`;
    }

    // Retrieve the users selected price range or selection & reshape the SQL based on it.
    let priceSelection = data.priceSelection;
    const minPriceSelection = data.minPriceSelection;
    const maxPriceSelection = data.maxPriceSelection;
    if (priceSelection == `FREE`) {
      query += ` AND price = 0`;
    } else if (priceSelection == `Under $10`) {
      query += ` AND price <= 10`;
    } else if (priceSelection == `Under $40`) {
      query += ` AND price <= 40`;
    } else if (!(minPriceSelection == "" && maxPriceSelection == "")) {
      query += ` AND price >= ${minPriceSelection} AND price <= ${maxPriceSelection}`;
    }
    // Arrays to be sent to the front-end later.
    let sharedGameNames = [];
    let ownedByWho = [];
    let gameImages = [];
    let gameLinks = [];
    let gameTags = [];
    let gamePrices = [];
    let allPotentialTags = []; // for the drop-down

    // First we'll iterate through EVERY room member. Goal is to run through each user and their games and "tick" off who owns what.
    for (let i = 0; i < roomMembers.length; i++) {
      const currentUserID = roomMembers[i][0];
      // Now we retrieve all the users recorded games and we'll loop those.
      // Query will only retrieve MULTI PLAYER games for the current user.
      const currentUsersGames = db.prepare(query).all(currentUserID);

      currentUsersGames.forEach((curGame) => {
        // TODO: Would it be better to use a games ID here? Can a game have the same name as another?
        const indexOfGame = sharedGameNames.indexOf(curGame.name);
        if (indexOfGame != -1) {

          // It IS THERE so curGame append the SteamID to the "current owners"
          ownedByWho[indexOfGame].push(i);
        } else {

          // It IS NOT there so make a new entry with name, image, & link
          sharedGameNames.push(curGame.name);
          gameImages.push(curGame.header_image);
          gameLinks.push(curGame.store_url);
          gameTags.push(curGame.tags);
          let prices = [];
          const initial_price = curGame.initial_price;
          const final_price = curGame.price;
          prices.push(final_price);
          if (initial_price != "" && initial_price != 0) {
            prices.push(initial_price);
          }
          gamePrices.push(prices);

          // Add the SteamID to a new array and start the appending process
          let temp = [];
          temp.push(i);
          ownedByWho.push(temp);

          // Lets process the tags to send to the front end
          // TODO: We should probably also remove the current (or previously) selected tags so they don't get queried again from the database.
          allPotentialTags = maintainTags(curGame.tags, allPotentialTags);
        }
      });

      // Locates the socket for that specific room
      socket.join("room-" + data.roomNumber);
    }

    // TODO: How to handle refreshes when a new user joins or leaves a room?
    // Finally emit the data to all room members INDIVIDUALLY so filtering options don't change the page for everyone.
    io.to(socket.id).emit("finalList", {
      roomMembers: roomMembers,
      games: sharedGameNames,
      owners: ownedByWho,
      images: gameImages,
      links: gameLinks,
      tags: gameTags,
      prices: gamePrices,
      categories: allPotentialTags,
    });
    
  });

});


// DEBUG: For checking HTML elements on a safe page.
app.get("/test", async (req, res) => {
  console.log(`Running Test.`);

    console.log(socketRooms);
    // console.log(socketRooms[0].roomMembers);
    // console.log(socketRooms[0].roomNumber);

  res.render("test");
});

// DEBUG: For checking functions and other back-end code.
app.get("/altTest", async (req, res) => {
  console.log("Checking for new games to add...");

  let gameInfo = [];
  let gameCount = 0;
  // Set this to whomever's account to pre-add their games to the database
  let steamID = `76561198016716226`;

  // An API function that will set gameCount and gameInfo to the total count of a users games and an array of their games respectively.
  await steamWrapper
    .getOwnedGames(steamID, null, true)
    .then((result) => {
      gameCount = result.data.count;
      gameInfo = result.data.games;
    })
    .catch(console.error);

  // gameCount = 600;

  // We iterate through the users' games using the data from the above function
  for (let curGame = 0; curGame < gameCount; curGame++) {
    const gameName = gameInfo[curGame].name;
    const gamePic = gameInfo[curGame].url_store_header;
    const gameURL = gameInfo[curGame].url_store;
    const gameID = gameInfo[curGame].appID;

    // Variables that are et later with API fetches
    let tags = "";
    let genre = "";
    let final_price = 0;
    let initial_price = 0;

    // FIRST we query our database to see if we HAVE the game or not
    const localGame = db
      .prepare("SELECT * FROM Games WHERE gameID = ?")
      .get(`${gameID}`);

    // Then check if the user has the local game registered in the database
    const userPotentialGame = db
      .prepare("SELECT * FROM Users WHERE userID = ? AND gameID = ?")
      .get([`${steamID}`, `${gameID}`]);

    // if the game is located we check if the user has the game in their database
    if (localGame) {
      // IFF >= 3 days old then re-query
      if (computeDateDiff(localGame.age)) {
        // TODO:
      }
      // If they don't have the game in their table we add it to their database else do nothing
      if (!userPotentialGame) {
        db.prepare(`INSERT INTO Users (userID, gameID) VALUES (?, ?)`).run(
          steamID,
          `${gameID}`
        );
      }
    } else {
      // Case if the game is not located in the database
      // We query game and add it to the Games table along with the users personal table
      tags = await fetchTags(gameID);
      let temp = await fetchGenresPrices(gameID);
      genre = temp[0];
      initial_price = temp[1];
      final_price = temp[2];
      let is_multiplayer = 1;
      let age = generateDate();

      // If its single player
      if (!genre.includes(`Multi-player`)) {
        is_multiplayer = 0;
      }

      console.log(gameID);
      db.prepare(
        `INSERT INTO Games(gameID, name, genre, tags, age, price, initial_price, is_multiplayer, header_image, store_url) VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        `${gameID}`,
        gameName,
        genre,
        tags,
        age,
        final_price,
        initial_price,
        `${is_multiplayer}`,
        gamePic,
        gameURL
      );

      db.prepare(`INSERT INTO Users (userID, gameID) VALUES (?,?)`).run(
        steamID,
        `${gameID}`
      );
    }
  }

  console.log("Finished adding games!");

  res.render("altTest");
});

// Intended to be the FULL logout from Steam & the Room.
app.get("/logout", (req, res) => {
    const roomNumber = req.cookies.roomNumber;
    const curUsersID = req.cookies.steamID;
    let potentialRoom = socketRooms.find((x) => x.roomNumber === roomNumber);
    
    if (potentialRoom) { // our room was found so delete the user
        if (potentialRoom.roomMembers.length == 1) { // user is the sole person in the room
            deleteRoom(roomNumber);
            // otherwise they're in a populated room and need to be specifically removed
        } else {
            deleteUserFromRoom(roomNumber, curUsersID);
        }
    } else {
        console.error(`ERROR: User was in a room that doesn't exist anymore?`);
    }

    // After removing them from a room, we'll clear their cookies.
  res.clearCookie("steamID");
  res.clearCookie("username");
  res.clearCookie("avatar");
  res.clearCookie("roomNumber");

  res.render("index");
});

// Same functionality as logout but only clear the roomNumber
app.get('/leave', (req, res) => {
  const roomNumber = req.cookies.roomNumber;
  const curUsersID = req.cookies.steamID;
  let potentialRoom = socketRooms.find((x) => x.roomNumber === roomNumber);
  
  if (potentialRoom) { // our room was found so delete the user
      if (potentialRoom.roomMembers.length == 1) { // user is the sole person in the room
          deleteRoom(roomNumber);
          // otherwise they're in a populated room and need to be specifically removed
      } else { 
          deleteUserFromRoom(roomNumber, curUsersID);
      }
  } else {
      console.error(`ERROR: User was in a room that doesn't exist anymore?`);
  }

  res.clearCookie('roomNumber');

  res.render('room-choice');
});

// Starts server
// server.listen(80, () => {
//   console.log(`SocketIO Server has Started!`);
// });
 
// TODO: Confirm weird HTTP issues
server.listen(443, () => {
  console.log('HTTPS server running on port 443');
});