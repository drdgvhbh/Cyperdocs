import { Theme } from '@/App';
import { Navbar } from '@/components/Navbar';
import {
  AuthenticateWithDecryptedTokenMessage,
  InitialStateMessage,
  IssueGrantMessage,
  RequestGrantMessage,
  RequestUpdatedDocumentFromPeerMessage,
  SendEncryptedTokenMessage,
  SendIdentityMessage,
  SendUpdatedDocumentMessage,
} from '@/store/document/connection-protocol';
import { boundMethod } from 'autobind-decorator';
import automerge from 'automerge';
import { createHash } from 'crypto';
import Immutable, { Map } from 'immutable';
import Peer from 'peerjs';
import React, { Component } from 'react';
import injectSheet, { WithSheet } from 'react-jss';
import { RouteComponentProps } from 'react-router';
import { Operation, Value } from 'slate';
import Editor from './Editor';
import { mapDispatchToProps, mapStateToProps } from './EditorPageContainer';
import { initialValue as initialValueBob } from './initial-value.bob';
import { initialValue as initialValueAlice } from './initialValue.alice';

const styles = (theme: typeof Theme) => ({
  page: {
    textAlign: 'center',
    backgroundColor: theme.backgroundColor,
    height: '100%',
  },
  editor: {
    height: '100%',
  },
});

interface ChangeMessage {
  type: 'CHANGE';
  changeData: string;
  originPeerID: string;
  slateHash: string;
}

interface PeerConnectionData {
  isAuthorized: boolean;
  connection: Peer.DataConnection;
}

interface AppState {
  peers: Map<string, PeerConnectionData>;
  connectingPeerID: string;
}

type EditorPageActions = typeof mapDispatchToProps;
type EditorPageStateProps = ReturnType<typeof mapStateToProps>;

export interface EditorPageProps
  extends EditorPageActions,
    EditorPageStateProps,
    WithSheet<typeof styles>,
    RouteComponentProps {}

class EditorPage extends Component<EditorPageProps, AppState> {
  public state: AppState;

  private self!: Peer;

  constructor(props: any) {
    super(props);

    this.state = {
      connectingPeerID: '',
      peers: Map(),
    };
  }

  public componentDidMount(): void {
    const {
      loadDocumentFromSwarm,
      syncDocumentWithCurrentSlateData,
      setDocumentID,
      setSlateRepr,
      setDocumentData,
      role,
    } = this.props;

    const documentID = this.props.history.location.pathname.match(
      /[^/]*$/g,
    )!![0];

    const initialValueJSON =
      role === 'Alice' ? (initialValueAlice as any) : (initialValueBob as any);
    const initialValue = Value.fromJSON(initialValueJSON);

    setSlateRepr(initialValue);
    syncDocumentWithCurrentSlateData();

    if (role === 'Alice') {
      setDocumentID(documentID);
      loadDocumentFromSwarm();
    }

    this.self = new Peer({
      secure: true,
      host: process.env.REACT_APP_PEER_SERVER_HOST,
      port: 443,
      path: '/swag',
    });

    const {
      setPeerID,
      sendAuthenticationTokenToPeer,
      authenticatePeer,
      issueGrant,
    } = this.props;

    this.self.on('open', (peerID) => {
      console.log(peerID);
      setPeerID(peerID);
    });
    this.self.on('connection', (conn) => {
      this.setState({
        peers: this.state.peers.set(conn.peer, {
          connection: conn,
          isAuthorized: role === 'Alice',
        }),
      });
      conn.on('close', () => {
        this.setState({ peers: this.state.peers.remove(conn.peer) });
      });
      conn.on(
        'data',
        async (
          data:
            | ChangeMessage
            | RequestUpdatedDocumentFromPeerMessage
            | SendUpdatedDocumentMessage
            | RequestGrantMessage
            | SendIdentityMessage
            | AuthenticateWithDecryptedTokenMessage,
        ) => {
          switch (data.type) {
            case 'AUTHENTICATE_WITH_DECRYPTED_TOKEN_MESSAGE': {
              authenticatePeer({
                decryptedToken: data.token,
                bobVerifyingKey: data.bobVerifyingKey,
                connection: conn,
              });
              break;
            }
            case 'REQUEST_GRANT_MESSAGE': {
              issueGrant({
                label: data.label,
                bobEncryptingKey: data.bob.encryptingKey,
                bobVerifyingKey: data.bob.verifyingKey,
                connection: conn,
              });
              break;
            }
            case 'SEND_IDENTITY_MESSAGE': {
              sendAuthenticationTokenToPeer({
                bobVerifyingKey: data.bobVerifyingKey,
                connection: conn,
              });
              break;
            }
            case 'CHANGE': {
              const {
                applyRemoteChangeToLocalDocument,
                checkifRemoteSlateHashMatchesAfterChange,
              } = this.props;
              const connectionData = this.state.peers.get(data.originPeerID);
              if (!connectionData.isAuthorized) {
                break;
              }
              const changeData = JSON.parse(data.changeData);
              applyRemoteChangeToLocalDocument(changeData);
              checkifRemoteSlateHashMatchesAfterChange({
                hash: data.slateHash,
                connection: connectionData.connection,
              });
              break;
            }
            case 'REQUEST_UPDATED_DOCUMENT_FROM_PEER': {
              const requestingPeerConnectionData = this.state.peers.get(
                conn.peer,
              );

              if (!requestingPeerConnectionData.isAuthorized) {
                break;
              }

              const { sendUpdatedDocument } = this.props;
              const currentDoc = this.props.data;

              const changeData = JSON.stringify(
                automerge.getChanges(automerge.init(), currentDoc!!),
              );

              sendUpdatedDocument({
                connection: requestingPeerConnectionData.connection,
                document: changeData,
              });
              break;
            }
            case 'SEND_UPDATED_DOCUMENT_MESSAGE': {
              const currentDoc = this.props.data;
              const { applyRemoteChangeToLocalDocument } = this.props;
              try {
                const doc = JSON.parse(data.document);
                const newDoc = automerge.applyChanges(automerge.init(), doc);
                const newMergedDoc = automerge.merge(currentDoc, newDoc);

                const changes = automerge.getChanges(currentDoc, newMergedDoc);
                if (changes.length > 0) {
                  applyRemoteChangeToLocalDocument(changes);
                }
              } catch (err) {
                console.log(err);
              }
            }
            default:
              break;
          }
        },
      );
    });
  }

  public render(): JSX.Element {
    const { connectingPeerID, peers } = this.state;
    const { classes, slateRepr, isLoading, role, sendIdentity } = this.props;
    return (
      <div className={classes.page}>
        <Navbar />
        {role === 'Bob' && peers.size === 0 && (
          <React.Fragment>
            <input
              onChange={(e) => {
                this.setState({ connectingPeerID: e.target.value });
              }}
            />
            <button onClick={() => this.connectToAlice(connectingPeerID)}>
              Connect
            </button>
          </React.Fragment>
        )}

        <Editor
          isLoading={isLoading}
          className={classes.editor}
          value={slateRepr}
          onChange={({ value, operations }) => {
            return this.onChange({ value, operations });
          }}
          applyInset={true}
        />
      </div>
    );
  }

  public componentDidUpdate(prevProps: EditorPageProps): void {
    const previousDoc = prevProps.data;
    const currentDoc = this.props.data;

    try {
      const changes = automerge.getChanges(previousDoc, currentDoc);
      if (changes.length > 0) {
        const changeData = JSON.stringify(changes);
        const { peers } = this.state;
        const { slateRepr, peerID: myPeerID } = this.props;
        const slateHash = createHash('sha256')
          .update(JSON.stringify(slateRepr.toJSON()))
          .digest('base64');

        peers.keySeq().forEach((peerID) => {
          const connectionData = peers.get(peerID!);
          if (!connectionData.isAuthorized) {
            return;
          }
          const changeMessage: ChangeMessage = {
            type: 'CHANGE',
            originPeerID: myPeerID,
            changeData,
            slateHash,
          };
          connectionData.connection.send(changeMessage);
        });
      }
    } catch (err) {
      if (err instanceof RangeError) {
        return;
      }

      throw err;
    }
  }

  @boundMethod
  private onChange({
    value,
    operations,
  }: {
    operations: Immutable.List<Operation>;
    value: Value;
  }): void {
    const { setSlateRepr, applyLocalChange } = this.props;
    setSlateRepr(value);

    const currentDoc = this.props.data;

    if (!currentDoc) {
      return;
    }

    applyLocalChange(operations);
  }

  @boundMethod
  private connectToAlice(
    connectingPeerID: string,
  ): Promise<Peer.DataConnection> {
    return new Promise<Peer.DataConnection>((res) => {
      const connection = this.self.connect(connectingPeerID);
      connection.on('open', () => {
        const { role, sendIdentity } = this.props;
        const { peers } = this.state;
        this.setState({
          peers: peers.set(connectingPeerID, {
            connection,
            isAuthorized: role === 'Alice',
          }),
        });
        sendIdentity({ connection });
        this.addBobHandlersToConnection(connection);
        res(connection);
      });
    });
  }

  @boundMethod
  private addBobHandlersToConnection(connection: Peer.DataConnection): void {
    const {
      requestGrantFromAlice,
      authenticateWithDecryptedAuthenticationToken,
      setDocumentData,
    } = this.props;
    connection.on(
      'data',
      async (
        data:
          | SendEncryptedTokenMessage
          | IssueGrantMessage
          | InitialStateMessage,
      ) => {
        switch (data.type) {
          case 'INITIAL_STATE_MESSAGE': {
            const doc = JSON.parse(data.initialState);
            const newDoc = automerge.applyChanges(automerge.init(), doc);
            setDocumentData(newDoc);
            break;
          }
          case 'ISSUE_GRANT_MESSAGE': {
            localStorage.setItem(data.label, data.policyEncryptingKey);
            localStorage.setItem(
              data.policyEncryptingKey,
              data.aliceVerifyingKey,
            );
            connection.on('close', async () =>
              this.connectToAlice(connection.peer),
            );
            connection.close();
            break;
          }
          case 'SEND_ENCRYPTED_TOKEN_MESSAGE': {
            const policyEncryptingKey = localStorage.getItem(data.label);
            if (!policyEncryptingKey) {
              requestGrantFromAlice({
                label: data.label,
                connection,
              });
              break;
            }
            const aliceVerifyingKey = localStorage.getItem(policyEncryptingKey);
            if (!aliceVerifyingKey) {
              requestGrantFromAlice({
                label: data.label,
                connection,
              });
              break;
            }

            authenticateWithDecryptedAuthenticationToken({
              label: data.label,
              encryptedToken: data.token,
              connection,
              policyEncryptingKey,
              aliceVerifyingKey,
            });
            break;
          }
          default:
            break;
        }
      },
    );
  }
}

export default injectSheet(styles)(EditorPage);
