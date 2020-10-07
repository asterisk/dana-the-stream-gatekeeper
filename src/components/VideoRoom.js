import React, { Component, Fragment } from 'react';
import { withStyles } from '@material-ui/styles';
import { withContext } from '../contexts/AppContext';
import SipClient from '../lib/SipClient';
import mqtt from 'async-mqtt';
import Video from './Video';
import TopBar from './TopBar';
import { Beforeunload } from 'react-beforeunload';

import {
    Avatar,
    Button,
    Typography,
    Container,
    Grid,
    Drawer,
    Snackbar,
    IconButton,
    List,
    ListItemText,
    ListItem,
    TextField
} from '@material-ui/core';

import {
    ArrowBack as BackIcon,
    Videocam as VideoCamIcon,
    ScreenShare as ScreenShareIcon,
    StopScreenShare as StopScreenShareIcon,
    Error as ErrorIcon,
    Close as CloseIcon,
    Mic as MicIcon,
    MicOff as MicOffIcon,
    Forum as ForumIcon,
    Chat as ChatIcon
} from '@material-ui/icons';

const styles = theme => ({
    '@global': {
        body: {
            ackgroundColor: theme.palette.common.white,
        },
    },
    paper: {
        marginTop: theme.spacing(8),
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
    },
    avatar: {
        margin: theme.spacing(1),
        backgroundColor: theme.palette.secondary.main,
    },
    form: {
        width: '100%', // Fix IE 11 issue.
        marginTop: theme.spacing(1),
    },
    submit: {
        margin: theme.spacing(3, 0, 2),
    },
    root: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        overflow: 'hidden'
    },
    bottomRow: {
        position: 'absolute',
        height: '200px',
        bottom: 0,
        left: 0,
        right: 0,
        overflow: 'hidden',
        paddingRight: '15px'
    },
    errorMessage: {
        display: 'flex',
        alignItems: 'center',
    },
    errorIcon: {
        fontSize: 20,
        opacity: 0.9,
        marginRight: theme.spacing(1),
    },
    drawerList: {
        width:'250px'
    }
});


class VideoRoom extends Component {
    constructor(props) {
        super(props);

        this.state = {
            localStreams: new Map(),
            streams: new Map(),
            connect: false,
            selectedStream: null,
            session: null,
            screensharing: false,
            snackOpen: false,
            transcriptionDrawerOpen: false,
            chatDrawerOpen: false,
            errorMessage: '',
            onSnackCloseAction: null,
            remoteAudioStream: null,
            remoteAudioMuted: false,
            transcription: new Map(),
            chat: new Set(),
        };

        try {
            this._sip = new SipClient({
                name             : props.name,
                sipUri           : props.sipUri,
                sipPassword      : props.password,
                wsUri            : props.serverWssUri,
                pcConfig         : {
                    iceServers: [
                        {
                            urls: [ 'stun:stun.l.google.com:19302']
                        }
                    ]
                }
            });

            if (props.mqttUri) {
                this._connectToMqtt(props.mqttUri);
            }

        } catch(err) {
            this.setState({ snackOpen: true, errorMessage: err.message });
        }
    }

    async _connectToMqtt(mqttUri) {
        console.log('connecting to mqtt');
        try {
            this._mqtt = await mqtt.connectAsync(mqttUri);
            console.log('connected to mqtt?', this._mqtt);
            this._mqtt.on('message', this._handleMqttMessage.bind(this));
        } catch (err) {
            console.log('error connecting to mqtt', err);
        }
    }

    async getScreenShareMedia() {
        let stream;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: 'always'
                },
                audio: false
            });

            let track = stream.getVideoTracks()[0];
            track.contentHint = 'detail';

            this.setState((prevState) => {
                let localStreams = prevState.localStreams;

                //find the previous one and delete it
                localStreams.delete('screen-share');

                localStreams.set('screen-share', stream);
                return {
                    ...prevState,
                    localStreams
                }
            });

            track.onended = () => {
                this._stopScreenShare();
            };
        } catch(err) {
            this.setState({ snackOpen: true, errorMessage: err.message });
        }

        return stream;
    }

    async getStream() {

        let devices = await navigator.mediaDevices.enumerateDevices();
        let { chosenAudioInput, chosenVideoInput } = this.props;

        //if we can support 4k then we should
        let constraints = {
            audio: true,
            video: {
                width: { min: 640, ideal: 1920, max: 3840 },
                height: { min: 400, ideal: 1080, max: 2160 },
                aspectRatio: { ideal: 1.7777777778 }
            }
        }
        if (chosenAudioInput) {

            //do we have it?
            let found = devices.some((device) => {
                console.log(device, chosenAudioInput);
                return device.deviceId === chosenAudioInput;
            })
            if (found) {
                constraints.audio = {
                    deviceId: { exact: chosenAudioInput }
                }
            }
        }

        if (chosenVideoInput) {
            //do we have it?
            let found = devices.some((device) => {
                console.log(device, chosenVideoInput);

                return device.deviceId === chosenVideoInput;
            })
            if (found) {
                constraints.video.deviceId = { exact: chosenVideoInput };
            }
        }

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);

            this.setState((prevState) => {
                let localStreams = prevState.localStreams;

                //find the previous one and delete it
                localStreams.delete('local-camera');
                localStreams.set('local-camera', stream);
                return {
                    ...prevState,
                    localStreams
                }
            });
        } catch (err) {
            this.setState({ snackOpen: true, errorMessage: err.message });
        }

        return stream;
    }

    handleSession (session) {
        this.setState({ session });

        session.on('newTrack', (evt) => {

            let stream = evt.streams[0];

            console.log(evt);

            //this shouldnt be needed but alas I still get a video track with the audio track...
            if (this.state.streams.has(stream.id) || (this.state.remoteAudioStream && this.state.remoteAudioStream.id === stream.id)) {
                return;
            }

            let track = evt.track;

            track.addEventListener('ended', () => {
                this.setState((prevState) => {
                    let streams = prevState.streams;
                    streams.delete(stream.id);
                    return {
                        ...prevState,
                        streams
                    }
                });
            })

            //theres only one audio track from asterisk
            if (track.kind === 'audio') {
                console.log('got a stream with audio track', stream);
                this.setState({remoteAudioStream: stream});
                this._remoteAudio = new Audio();
                this._remoteAudio.srcObject = this.state.remoteAudioStream;
                this._remoteAudio.play();
            } else {

                console.log('non audio track', track.kind);

                if (!this.state.streams.has(stream.id)) {
                    let component = (<Video key={stream.id} stream={stream} muted={false} enableControls={true} inGrid={true}/>)

                    this.setState((prevState) => {
                        let streams = prevState.streams;
                        streams.set(stream.id, component);
                        return {
                            ...prevState,
                            streams
                        }
                    });
                }
            }

            // stream.onremovetrack = () => {
            //     console.log('track ended');
            //     if (!stream.getTracks().length) {
            //         this.setState((prevState) => {
            //             let streams = prevState.streams;
            //             streams.delete(stream.id);
            //             return {
            //                 ...prevState,
            //                 streams
            //             }
            //         });
            //     }
            // };

        });

        // session.on('streamRemoved', (stream) => {
        //     this.setState((prevState) => {
        //         let streams = prevState.streams;
        //         streams.delete(stream.id);
        //         return {
        //             ...prevState,
        //             streams
        //         }
        //     });
        // });

        session.on('terminate', (endInfo) => {
            if (session.status === 'failed') {
                this.setState({
                    snackOpen: true,
                    errorMessage: endInfo.cause,
                    onSnackCloseAction: () => {
                        this.props.history.push('/');
                    }
                });

            }
        })

        this._sip.on('participantWelcomeReceived', (msg) => {
            console.log('participant welcome', msg)
        })

        this._sip.on('participantInfoReceived', (msg) => {
            console.log('participant info', msg)
        })

        this._sip.on('messageReceived', (msg) => {
            console.log('got a message', msg);
            let {chat} = this.state;
            chat.add({name: msg.From, text: msg.Body});
            this.setState({ chat });
        })
    }

    _handleMqttMessage(topic, message) {
        if (topic.includes('transcript')) {
            console.log('got a message', message.toString());
            let {transcription} = this.state;
            let msg = JSON.parse(message);
            console.log(msg);
            transcription.delete(msg.id);
            transcription.set(msg.id, msg);

            this.setState({ transcription });
        }
    }

    async _call() {
        const { match } = this.props;
        this.setState({connect: true});
        if (match.params.name) {
            this._sip.on('connected', () => {
                let localCameraStream = this.state.localStreams.get('local-camera').clone();
                this._sip.call(match.params.name, localCameraStream);
            });
            if (this._mqtt) {
                try {
                    let result = this._mqtt.subscribe(`danatsg/${match.params.name}/transcription`);
                    console.log('subscription was ', result);
                } catch(err) {
                    console.log('ERR', err);
                }
            }
        }
        this._sip.start();
    }

    _sendChat(e) {
        e.preventDefault();
        e.stopPropagation();
        let { session } = this.state;
        console.log(this.textChatRef.value);
        if (session) {
            session.sendMessage(this._sip.name, this.textChatRef.value);
            let {chat} = this.state;
            chat.add({name: this._sip.name, text: this.textChatRef.value});
            this.setState({ chat });
        }
        this.textChatRef.value = '';
    }

    tearDownLocalStreams() {
        let { localStreams } = this.state;
        if (localStreams) {
            localStreams.forEach((stream) => {
                stream.getTracks().forEach((track) => {
                    track.stop();
                });
            });

            this.setState((prevState) => {
                let localStreams = prevState.localStreams;

                localStreams.clear();
                return {
                    ...prevState,
                    localStreams
                }
            });
        }
    }

    async componentDidMount () {
        await this.getStream();
        //await this.getScreenShareMedia();
        this._boundOnSession = this.handleSession.bind(this);
        this._sip.on('session', this._boundOnSession);
    }

    _terminate() {
        this.state.session && this.state.session.terminate();
    }

    componentWillUnmount() {
        this._sip.removeAllListeners('session');
        if (this.state.session) {
            this.state.session.terminate();
        }
        this._sip.stop();
        if (this._mqtt) {
            this._mqtt.end();
        }
        this.tearDownLocalStreams();
    }

    _renderConnectModal() {
        const { classes, history } = this.props;
        const { localStreams } = this.state;

        return (
            <Fragment>
                <TopBar>
                    <IconButton edge='end' color='inherit' aria-label='Back'  onClick={() => history.push('/')}>
                        <BackIcon />
                    </IconButton>
                </TopBar>
                <Container component="main" maxWidth="xs">
                    <div className={classes.paper}>
                        <Avatar className={classes.avatar}>
                            <VideoCamIcon />
                        </Avatar>
                        <Typography component="h1" variant="h5">
                            Do you look spiffing?
                        </Typography>
                        <Video stream={localStreams.get('local-camera')} previewVideo={true} enableControls={true} muted={true}/>
                        <Button
                            type="submit"
                            fullWidth
                            variant="contained"
                            color="primary"
                            className={classes.submit}
                            onClick={this._call.bind(this)}
                        >
                            Yes, Yes I do
                        </Button>
                    </div>
                </Container>
            </Fragment>
        );
    }

    async _startScreenShare() {
        const { match } = this.props;
        const { session } = this.state;
        if (match.params.name) {
            //go add the screen share track (from the screenShareStream) into the localStream
            let screenShareStream = await this.getScreenShareMedia();

            this._screenshareTransceiver = session.jssipRtcSession.connection.addTransceiver(screenShareStream.getVideoTracks()[0], {direction: 'sendonly', streams: [screenShareStream]});

            if(session.jssipRtcSession.renegotiate()) {
                console.log('renegotiating adding screenshare');
            }
            this.setState({screensharing: true});
        }
    }

    _stopScreenShare() {
        const { session } = this.state;

        this._screenshareTransceiver.stop();

        let screenShareStream = this.state.localStreams.get('screen-share');
        if (screenShareStream) {

            screenShareStream.getTracks().forEach((track) => {
                track.stop();
            })

            this.setState((prevState) => {
                let localStreams = prevState.localStreams;

                localStreams.delete('screen-share');
                return {
                    ...prevState,
                    localStreams
                }
            });
        }

        if(session.jssipRtcSession.renegotiate()) {
            console.log('renegotiating removal of screen share');
        }

        this.setState({screensharing: false});
    }

    selectedStream(stream) {
        this.setState({selectedStream: stream});
    }

    _renderStreams(streamsIterator, number) {
        let streamComponents = [];
        for (let i = 0; i < number; i++) {
            let videoComponent = streamsIterator.next().value;
            streamComponents.push(<Grid item key={i}>{videoComponent}</Grid>);
        }
        return streamComponents;
    }

    _renderStreamsContainer(streams) {
        let streamRows = []
        // streamComponents.push(<Grid item>
        //     <Video height={size} width={size} stream={myStream} muted={false} enableControls={true} onSelect={this.selectedStream.bind(this)} selected={this.state.selectedStream === myStream} />
        // </Grid>);

        // count how many streams there are and divide it by 2
        // for now we're going to always say there are 2 rows and we'll deal with making it clever later
        // ideally Asterisk would send us individual audio streams per video and so we'd do google meet
        // type auto selecting based on active speaker

        //let numToRender = Math.floor(streams.size / 2);
        let numToRender = streams.size;

        let streamsValue = streams.values();
       //[0, 1].forEach((key) => {
            streamRows.push(<Grid
                container
                direction="row"
                justify="center"
                alignItems="center"
                spacing={2}
                // key={key}
            >
                {this._renderStreams(streamsValue, numToRender)}
            </Grid>);
            //numToRender = streams.size - numToRender;
        //});

        // if(!this.state.selectedStream && streams.length) {
        //     this.state.selectedStream = streams.values().next().value;
        // }

        return streamRows;
    }

    _getTranscriptionListComponent() {
        let items = [];
        (new Map([...this.state.transcription].reverse())).forEach((transcription, index) => {
            let transText = '';
            if (transcription.platform === 'azure') {
                transText = transcription.results.text;
            } else if (transcription.platform === 'google') {
                transText = transcription.results.alternatives[0].transcript;
            } else if (transcription.platform === 'amazon') {
                transText = transcription.results[0].Transcript;
            }
            items.push(
                <ListItem divider={true} alignItems="flex-start" key={transcription.id}>
                    <ListItemText
                        primary={`${transcription.callerName} (${transcription.platform})`}
                        secondary={transText}
                    />
                </ListItem>
            );
        });
        return items;
    }

    _getChatListComponent() {
        return Array.from(this.state.chat).reverse().map((chat) => (
            <ListItem divider={true} alignItems="flex-start">
                <ListItemText
                    primary={chat.name}
                    secondary={chat.text}
                />
            </ListItem>
        ))
    }

    _handleSnackClose(event, reason) {
        if (reason === 'clickaway') {
          return;
        }

        let onSnackCloseAction = this.state.onSnackCloseAction;
        this.setState({snackOpen: false, errorMessage: '', onSnackCloseAction: null});
        if (onSnackCloseAction) {
            onSnackCloseAction();
        }
    };

    _toggleRemoteAudio() {
        if (this.state.remoteAudioStream) {
            this.state.remoteAudioStream.getAudioTracks().forEach((track) => {
                track.enabled = this.state.remoteAudioMuted;
            });
            this.setState({remoteAudioMuted: !this.state.remoteAudioMuted});
        }
    }

    render() {
        let { localStreams, streams, connect, screensharing, snackOpen, errorMessage, remoteAudioMuted } = this.state;
        let { classes, history }  = this.props;

        if (!connect) {
            return this._renderConnectModal();
        }

        let streamContainerMap = new Map();

        localStreams.forEach((stream) => {
            streamContainerMap.set(stream.id, <Video key={stream.id} stream={stream} myStreamGrid={true} enableControls={true} muted={true}/>);
        });
        let localStreamsValue = streamContainerMap.values();

        return (
            <Beforeunload onBeforeunload={this._terminate.bind(this)}>
                <div className={classes.root}>
                    <TopBar>
                        { remoteAudioMuted ?
                            <IconButton edge='end' color='inherit' aria-label='Un-mmute Remote Audio'  onClick={this._toggleRemoteAudio.bind(this)}>
                                <MicOffIcon />
                            </IconButton>
                        :
                            <IconButton edge='end' color='inherit' aria-label='Mute Remote Audio'  onClick={this._toggleRemoteAudio.bind(this)}>
                                <MicIcon />
                            </IconButton>
                        }
                        { screensharing ?
                            <IconButton edge='end' color='inherit' aria-label='Stop Screen Share'  onClick={this._stopScreenShare.bind(this)}>
                                <StopScreenShareIcon />
                            </IconButton>
                        :
                            <IconButton edge='end' color='inherit' aria-label='Screen Share'  onClick={this._startScreenShare.bind(this)}>
                                <ScreenShareIcon />
                            </IconButton>
                        }
                        <IconButton edge='end' color='inherit' aria-label='Transcription'  onClick={() => this.setState({transcriptionDrawerOpen: !this.state.transcriptionDrawerOpen})}>
                            <ForumIcon />
                        </IconButton>
                        <IconButton edge='end' color='inherit' aria-label='Chat'  onClick={() => this.setState({chatDrawerOpen: !this.state.chatDrawerOpen})}>
                            <ChatIcon />
                        </IconButton>
                        <IconButton edge='end' color='inherit' aria-label='Back'  onClick={() => history.push('/')}>
                            <BackIcon />
                        </IconButton>
                    </TopBar>

                    {this._renderStreamsContainer(streams)}

                    <Grid
                        container
                        direction="row"
                        justify="flex-end"
                        alignItems="center"
                        spacing={2}
                        className={classes.bottomRow}
                    >
                        {this._renderStreams(localStreamsValue, localStreams.size)}
                    </Grid>
                    <Drawer anchor="left" open={this.state.transcriptionDrawerOpen} onClose={() => this.setState({transcriptionDrawerOpen: !this.state.transcriptionDrawerOpen})}>
                        <List className={classes.drawerList}>
                            {this._getTranscriptionListComponent()}
                        </List>
                    </Drawer>
                    <Drawer anchor="left" open={this.state.chatDrawerOpen} onClose={() => this.setState({chatDrawerOpen: !this.state.chatDrawerOpen})}>
                        { this.state.session && this.state.session.jssipRtcSession && (
                            <form onSubmit={this._sendChat.bind(this)} noValidate autoComplete="off">
                                <TextField
                                    id="chat"
                                    label="Chat"
                                    multiline
                                    fullWidth
                                    rows={4}
                                    inputRef={(c) => {this.textChatRef = c}}
                                />
                                <Button
                                    type="submit"
                                    fullWidth
                                    variant="contained"
                                    color="primary"
                                    className={classes.submit}
                                >
                                    Send
                                </Button>
                            </form>
                        )}
                        <List className={classes.drawerList}>
                            {this._getChatListComponent()}
                        </List>
                    </Drawer>
                    <Snackbar
                        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
                        open={snackOpen}
                        autoHideDuration={6000}
                        onClose={this._handleSnackClose.bind(this)}
                        ContentProps={{
                            'aria-describedby': 'message-id',
                        }}
                        message={<span id='message-id' className={classes.errorMessage}><ErrorIcon className={classes.errorIcon}/>{errorMessage}</span>}
                        action={[
                            <IconButton
                                key="close"
                                aria-label="close"
                                color="inherit"
                                className={classes.close}
                                onClick={this._handleSnackClose.bind(this)}
                            >
                                <CloseIcon />
                            </IconButton>,
                        ]}
                    />
                </div>
            </Beforeunload>
        );
    }
}

export default withStyles(styles)(withContext(VideoRoom));