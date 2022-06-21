const express = require('express');
const http = require('http');
const bodyParser = require('body-parser');
const path = require('path');
const config = require('./config/config.json');
const log = require('console-log-level')({ level: config.server.logLevel })
const SpotifyWebApi = require('spotify-web-api-node');

  /*set up express router and set headers for cross origin requests*/
const app = express();
const server = http.createServer(app);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

  /*init spotify API */
let scopes = ['streaming', 'user-read-currently-playing', 'user-modify-playback-state', 'user-read-playback-state'];

let spotifyApi = new SpotifyWebApi({
    clientId: config.spotify.clientId,
    clientSecret: config.spotify.clientSecret,
    refreshToken: config.spotify.refreshToken,
});

 /*sets and refreshes access token every hour */
spotifyApi.setAccessToken(config.spotify.accessToken);
refreshToken();
setInterval(refreshToken, 1000 * 60 * 60);

  /*store device to be played back*/
let activeDevice = "";

function refreshToken(){
  spotifyApi.refreshAccessToken()
    .then(function(data) {
      log.debug('The access token has been refreshed!');
      spotifyApi.setAccessToken(data.body['access_token']);
    }, function(err) {
      log.debug('Could not refresh access token', err);
    }
  );
}

/*called in all error cases*/
/*token expired and no_device error are handled explicitly*/
function handleSpotifyError(err){
  if (err.body.error.status == 401){
    log.debug("access token expired, refreshing...");
    refreshToken();
  }
  else {
    log.debug("an error occured: " + err)
    return -1;
  }
}

  /*queries all devices and transfers playback to the first one discovered*/
function setActiveDevice() {
  let activeDevice ;
    /*find devices first and choose first one available*/
  spotifyApi.getMyDevices()
    .then(function(data) {
      let availableDevices = data.body.devices;
      log.debug("[Spotify Control] Getting available devices...");
      activeDevice = availableDevices[0];
    }, function(err) {
      handleSpotifyError(err);
    })
    .then(function(){       /*transfer to active device*/
      spotifyApi.transferMyPlayback([activeDevice.id], {"play": true})
        .then(function() {
          log.debug('[Spotify Control] Transfering playback to ' + activeDevice.name);
        }, function(err) {
          handleSpotifyError(err);
        });
    });
}

function pause(){
  spotifyApi.pause()
    .then(function() {
      log.debug('[Spotify Control] Playback paused');
    }, function(err) {
      handleSpotifyError(err);
    });
}

function play(){
  spotifyApi.play()
    .then(function() {
      log.debug('[Spotify Control] Playback started');
    }, function(err) {
      handleSpotifyError(err);
    });
}

function next(){
  spotifyApi.skipToNext()
    .then(function() {
      log.debug('[Spotify Control] Skip to next');
    }, function(err) {
      handleSpotifyError(err);
    });
}

function previous(){
  spotifyApi.skipToPrevious()
    .then(function() {
      log.debug('[Spotify Control] Skip to previous');
    }, function(err) {
      handleSpotifyError(err);
    });
}

function playMe(device, activePlaylistId){

  spotifyApi.transferMyPlayback([device], {"play": true})
    .then(function() {
      log.debug('[Spotify Control] Transfering playback to ' + device);

      setInitialVolume(config.volume[device]);
      spotifyApi.play({ context_uri: activePlaylistId })
        .then(function(data){
          log.debug("[Spotify Control] Playback started");
        }, function(err){
          handleSpotifyError(err);
        });


    }, function(err) {
      handleSpotifyError(err);
    });




}


function setInitialVolume(volume){
  spotifyApi.setVolume(volume).then(function () {
      log.debug('[Spotify Control] Setting volume to '+ volume);
      }, function(err) {
      handleSpotifyError(err);
    });

}


  /*gets available devices, searches for the active one and returns its volume*/
function setVolume(volume){
  let targetVolume = 0;
  spotifyApi.getMyDevices().
    then(function(data) {
      let availableDevices = data.body.devices;
      let currentVolume = 0;
      availableDevices.forEach(item => {
        if (item.is_active){
          currentVolume = item.volume_percent;
          log.debug("[Spotify Control]Current volume for active device is " + currentVolume);
          }
      });
      if (volume) targetVolume = currentVolume+1;
      else targetVolume = currentVolume-1;
    })
    .then(function(){
      if (targetVolume < 35)
        spotifyApi.setVolume(targetVolume).then(function () {
            log.debug('[Spotify Control] Setting volume to '+ targetVolume);
            }, function(err) {
            handleSpotifyError(err);
          });
      else
      log.debug("[Spotify Control]Target Volume too high " + targetVolume);


    }, function(err) {
      handleSpotifyError(err);
    });
}

function transferPlayback(id){
  spotifyApi.transferMyPlayback([id], {"play": true})
    .then(function() {
      log.debug('[Spotify Control] Transfering playback to ' + id);
    }, function(err) {
      handleSpotifyError(err);
    });
}

  /*endpoint to return all spotify connect devices on the network*/
  /*only used if sonos-kids-player is modified*/
app.get("/getDevices", function(req, res){
  spotifyApi.getMyDevices()
    .then(function(data) {
      let availableDevices = data.body.devices;
      log.debug("[Spotify Control] Getting available devices...");
      res.send(availableDevices);
    }, function(err) {
      handleSpotifyError(err);
    });
});

  /*endpoint transfer a playback to a specific device*/
  /*only used if sonos-kids-player is modified*/
app.get("/setDevice", function(req, res){
  transferPlayback(req.query.id);
});

/*endpoint to return all spotify connect devices on the network*/
/*only used if sonos-kids-player is modified*/
app.get("/currentlyPlaying", function(req, res){
  spotifyApi.getMyCurrentPlayingTrack()
    .then(function(data) {
      if (data.body.item != undefined){
        log.debug("[Spotify Control] Currently playing: " + data.body.item.name);
        res.send(data.body.item);
      }
      else {
        res.send({"status":"paused","error":"none"});
      }
    }, function(err) {
      handleSpotifyError(err);
    });
});


  /*sonos-kids-controller sends commands via http get and uses path names for encoding*/
  /*commands are as defined in sonos-kids-controller and mapped spotify calls*/
app.use(function(req, res){
  let command = path.parse(req.url);

  var requesterIP = req.ip.split(':')[3];
  log.debug("request coming from: " + requesterIP);

    /*this is the first command to be received. It always includes the device id encoded in between two /*/
    /*check this if we need to transfer the playback to a new device*/
  if(command.name.includes("spotify:") ){
    let dir = command.dir;

      //don't choose provided device, look up device based on IP address in config file
    //let newdevice = dir.split('/')[1];

    log.debug("choosing device: " + config.client[requesterIP]);

    if (config.client[requesterIP] != undefined)
      playMe(config.client[requesterIP], command.name);
    else {
      log.debug("error: device not found in list, stopping");
    }
  }


  else if (command.name == "pause")
    pause();

  else if (command.name == "play")
    play();

  else if (command.name == "next")
    next();

  else if (command.name == "previous")
    previous();

  else if (command.name == "+5")
    setVolume(1);

  else if (command.name == "-5")
    setVolume(0);

  let resp = {"status":"ok","error":"none"};
  res.send(resp);
});

server.listen(config.server.port, () => {
  log.debug("[Spotify Control] Webserver is running on port: " + config.server.port );
});
