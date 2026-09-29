// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Observe hosted Responses images without changing the stream delivered to Codex.
//! A registration is execution-scoped; each HTTP request captures its own owner.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use axum::body::Bytes;
use futures_util::{stream::BoxStream, Stream, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc::{UnboundedSender, WeakUnboundedSender};

use crate::attachments::generated_images::{
    index_path, persist_delivery_at, save_base64_image, GeneratedImageDelivery,
};

#[derive(Debug)]
struct DeliveryTarget {
    index_path: PathBuf,
    workspace: String,
    root_thread_id: String,
    sender: WeakUnboundedSender<Value>,
    active: AtomicBool,
}

fn targets() -> &'static Mutex<HashMap<String, Arc<DeliveryTarget>>> {
    static TARGETS: OnceLock<Mutex<HashMap<String, Arc<DeliveryTarget>>>> = OnceLock::new();
    TARGETS.get_or_init(Default::default)
}

pub(crate) struct DeliveryRegistration {
    token: String,
    target: Arc<DeliveryTarget>,
}

impl Drop for DeliveryRegistration {
    fn drop(&mut self) {
        self.target.active.store(false, Ordering::Release);
        let mut targets = targets().lock().expect("image delivery targets lock");
        if targets
            .get(&self.token)
            .is_some_and(|target| Arc::ptr_eq(target, &self.target))
        {
            targets.remove(&self.token);
        }
    }
}

pub(crate) fn register(
    token: &str,
    task_id: &str,
    workspace: &str,
    root_thread_id: &str,
    sender: &UnboundedSender<Value>,
) -> DeliveryRegistration {
    let target = Arc::new(DeliveryTarget {
        index_path: index_path(task_id),
        workspace: workspace.into(),
        root_thread_id: root_thread_id.into(),
        sender: sender.downgrade(),
        active: AtomicBool::new(true),
    });
    targets()
        .lock()
        .expect("image delivery targets lock")
        .insert(token.into(), target.clone());
    DeliveryRegistration {
        token: token.into(),
        target,
    }
}

#[derive(Clone)]
struct ImageOwner {
    thread_id: String,
    turn_id: String,
    root_turn_id: String,
}

pub(super) struct RequestDelivery {
    target: Arc<DeliveryTarget>,
    owner: Option<ImageOwner>,
    seen: HashSet<String>,
}

pub(super) fn capture(token: &str, body: &[u8]) -> Option<RequestDelivery> {
    let target = targets().lock().ok()?.get(token)?.clone();
    Some(RequestDelivery {
        target,
        owner: request_owner(body),
        seen: HashSet::new(),
    })
}

fn request_owner(body: &[u8]) -> Option<ImageOwner> {
    let request: Value = serde_json::from_slice(body).ok()?;
    let metadata = request.get("client_metadata")?;
    let nested = metadata
        .get("x-codex-turn-metadata")
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let field = |key| {
        metadata
            .get(key)
            .or_else(|| nested.as_ref()?.get(key))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    Some(ImageOwner {
        thread_id: field("thread_id")?,
        turn_id: field("turn_id")?,
        root_turn_id: field("root_turn_id")?,
    })
}

impl RequestDelivery {
    async fn observe(&mut self, event: &str) -> Result<(), String> {
        // SSE supports multiple data lines. The normalizer already validates UTF-8.
        let data = event
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        let Ok(event) = serde_json::from_str::<Value>(&data) else {
            return Ok(());
        };
        let items = match event["type"].as_str() {
            Some("response.output_item.done") => vec![&event["item"]],
            Some("response.completed") => event
                .pointer("/response/output")
                .and_then(Value::as_array)
                .map(|items| items.iter().collect())
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        for item in items {
            if item["type"] != "image_generation_call" || item["status"] != "completed" {
                continue;
            }
            if !self.target.active.load(Ordering::Acquire) {
                continue;
            }
            let owner = self
                .owner
                .clone()
                .ok_or("Generated image has no verifiable thread/turn ownership")?;
            let id = item["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("Generated image has no item ID")?
                .to_owned();
            if !self.seen.insert(id.clone()) {
                continue;
            }
            let target = self.target.clone();
            let encoded = item["result"].as_str().map(str::to_owned);
            let result = tokio::task::spawn_blocking(move || {
                if !target.active.load(Ordering::Acquire) {
                    return;
                }
                let artifact = encoded
                    .as_deref()
                    .ok_or_else(|| "Generated image result is missing".into())
                    .and_then(|encoded| save_base64_image(encoded, &target.workspace));
                let display_turn_id = if target.root_thread_id == owner.thread_id {
                    owner.turn_id.clone()
                } else {
                    owner.root_turn_id
                };
                let mut delivery = GeneratedImageDelivery {
                    thread_id: owner.thread_id,
                    turn_id: owner.turn_id,
                    root_thread_id: target.root_thread_id.clone(),
                    root_turn_id: display_turn_id,
                    image_id: id,
                    created_at: chrono::Utc::now().timestamp_millis(),
                    artifact: artifact.as_ref().ok().cloned(),
                    error: artifact.err(),
                };
                match persist_delivery_at(&target.index_path, &delivery) {
                    Ok(persisted) => delivery = persisted,
                    Err(error) => {
                        delivery.artifact = None;
                        delivery.error = Some(format!("Failed to persist image delivery: {error}"));
                    }
                }
                if target.active.load(Ordering::Acquire) {
                    if let Some(sender) = target.sender.upgrade() {
                        let _ = sender.send(json!({
                            "method": "item/completed",
                            "params": {
                                "threadId": delivery.thread_id,
                                "turnId": delivery.turn_id,
                                "item": delivery.item(),
                            }
                        }));
                    }
                }
            })
            .await;
            result.map_err(|e| format!("Generated image delivery failed: {e}"))?;
        }
        Ok(())
    }
}

/// Persist and enqueue before forwarding the frame containing the completed image.
pub(super) fn observe_stream<S, E>(
    stream: S,
    delivery: Option<RequestDelivery>,
) -> BoxStream<'static, Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: ToString + Send + 'static,
{
    let stream = stream
        .map(|result| result.map_err(|e| std::io::Error::other(e.to_string())))
        .boxed();
    let Some(delivery) = delivery else {
        return stream;
    };
    struct State {
        stream: BoxStream<'static, Result<Bytes, std::io::Error>>,
        delivery: RequestDelivery,
        pending: String,
        utf8: Vec<u8>,
        done: bool,
    }
    let state = State {
        stream,
        delivery,
        pending: String::new(),
        utf8: Vec::new(),
        done: false,
    };
    futures_util::stream::unfold(state, |mut state| async move {
        loop {
            let frame = super::take_sse_block(&mut state.pending).or_else(|| {
                (state.done && !state.pending.is_empty())
                    .then(|| std::mem::take(&mut state.pending))
            });
            if let Some(frame) = frame {
                if let Err(error) = state.delivery.observe(&frame).await {
                    state.done = true;
                    state.pending.clear();
                    return Some((Ok(super::responses_failed_event(&error)), state));
                }
                return Some((Ok(Bytes::from(format!("{frame}\n\n"))), state));
            }
            if state.done {
                return None;
            }
            match state.stream.next().await {
                Some(Ok(bytes)) => {
                    if let Err(error) =
                        super::append_stream_utf8(&mut state.pending, &mut state.utf8, &bytes)
                    {
                        state.done = true;
                        state.pending.clear();
                        return Some((Err(error), state));
                    }
                }
                Some(Err(error)) => {
                    state.done = true;
                    state.pending.clear();
                    return Some((Err(error), state));
                }
                None => {
                    state.done = true;
                    if let Err(error) = super::finish_stream_utf8(&state.utf8) {
                        state.pending.clear();
                        return Some((Err(error), state));
                    }
                }
            }
        }
    })
    .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachments::generated_images::tests::png_base64;
    use futures_util::TryStreamExt;
    use tokio::sync::mpsc;

    fn fixture(
        root: &std::path::Path,
    ) -> (
        RequestDelivery,
        mpsc::UnboundedSender<Value>,
        mpsc::UnboundedReceiver<Value>,
    ) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let target = Arc::new(DeliveryTarget {
            index_path: root.join("private/index.json"),
            workspace: root.display().to_string(),
            root_thread_id: "root".into(),
            sender: sender.downgrade(),
            active: AtomicBool::new(true),
        });
        (
            RequestDelivery {
                target,
                owner: Some(ImageOwner {
                    thread_id: "root".into(),
                    turn_id: "turn-1".into(),
                    root_turn_id: "turn-1".into(),
                }),
                seen: HashSet::new(),
            },
            sender,
            receiver,
        )
    }

    fn image(id: &str) -> Value {
        json!({"id": id, "type": "image_generation_call", "status": "completed", "result": png_base64()})
    }

    fn done(item: Value) -> String {
        format!(
            "event: response.output_item.done\ndata: {}\n\n",
            json!({"type":"response.output_item.done", "item":item})
        )
    }

    fn completed(items: Vec<Value>) -> String {
        format!(
            "event: response.completed\ndata: {}\n\n",
            json!({"type":"response.completed", "response":{"status":"completed","output":items}})
        )
    }

    async fn forward(delivery: RequestDelivery, wire: &str, chunk_size: usize) -> String {
        let chunks = wire
            .as_bytes()
            .chunks(chunk_size)
            .map(|chunk| Ok::<_, std::io::Error>(Bytes::copy_from_slice(chunk)))
            .collect::<Vec<_>>();
        let output = observe_stream(futures_util::stream::iter(chunks), Some(delivery))
            .try_collect::<Vec<_>>()
            .await
            .unwrap();
        String::from_utf8(output.concat()).unwrap()
    }

    #[tokio::test]
    async fn fragmented_sse_delivers_once_before_terminal_and_does_not_change_codex_result() {
        let root = tempfile::tempdir().unwrap();
        let (delivery, _sender, mut receiver) = fixture(root.path());
        let item = image("ig-1");
        let wire = format!("{}{}", done(item.clone()), completed(vec![item]));
        let output = forward(delivery, &wire, 7).await;
        assert_eq!(output, wire);
        let notification = receiver.try_recv().unwrap();
        assert_eq!(notification["params"]["turnId"], "turn-1");
        assert!(std::path::Path::new(
            notification["params"]["item"]["savedPath"]
                .as_str()
                .unwrap()
        )
        .is_file());
        assert!(receiver.try_recv().is_err());
        assert!(!notification.to_string().contains(&png_base64()));
        assert!(root.path().join("private/index.json").is_file());
    }

    #[tokio::test]
    async fn terminal_only_multiple_images_and_utf8_crlf_are_supported() {
        let root = tempfile::tempdir().unwrap();
        let (delivery, _sender, mut receiver) = fixture(root.path());
        let mut item = image("ig-1");
        item["revised_prompt"] = json!("蓝色图片");
        let wire = completed(vec![item, image("ig-2")]).replace('\n', "\r\n");
        forward(delivery, &wire, 1).await;
        assert_eq!(receiver.try_recv().unwrap()["params"]["item"]["id"], "ig-1");
        assert_eq!(receiver.try_recv().unwrap()["params"]["item"]["id"], "ig-2");
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn persistence_is_complete_before_the_completed_frame_is_readable() {
        let root = tempfile::tempdir().unwrap();
        let (delivery, _sender, mut receiver) = fixture(root.path());
        let stream = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(
            completed(vec![image("ig")]),
        ))]);
        let mut stream = observe_stream(stream, Some(delivery));
        assert!(stream.next().await.unwrap().is_ok());
        assert!(receiver.try_recv().is_ok());
        assert!(root.path().join("private/index.json").is_file());
    }

    #[tokio::test]
    async fn partial_images_are_never_delivered() {
        let root = tempfile::tempdir().unwrap();
        let (delivery, _sender, mut receiver) = fixture(root.path());
        let mut item = image("ig");
        item["status"] = json!("in_progress");
        forward(delivery, &done(item), 11).await;
        assert!(receiver.try_recv().is_err());
        assert!(!root.path().join("private/index.json").exists());
    }

    #[tokio::test]
    async fn image_and_index_errors_emit_small_failed_items() {
        for index_failure in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (delivery, _sender, mut receiver) = fixture(root.path());
            let mut item = image("ig");
            if index_failure {
                std::fs::write(root.path().join("private"), b"not a directory").unwrap();
            } else {
                item["result"] = json!("invalid base64");
            }
            let wire = done(item);
            assert_eq!(forward(delivery, &wire, 13).await, wire);
            let item = &receiver.try_recv().unwrap()["params"]["item"];
            assert_eq!(item["status"], "failed");
            assert!(item["deliveryError"]
                .as_str()
                .unwrap()
                .contains(if index_failure { "persist" } else { "Base64" }));
            assert!(item["savedPath"].is_null());
        }
    }

    #[tokio::test]
    async fn concurrent_root_child_and_late_requests_keep_their_own_turns() {
        let root = tempfile::tempdir().unwrap();
        let (first, sender, mut receiver) = fixture(root.path());
        let child = RequestDelivery {
            target: first.target.clone(),
            owner: Some(ImageOwner {
                thread_id: "child".into(),
                turn_id: "child-turn".into(),
                root_turn_id: "turn-2".into(),
            }),
            seen: HashSet::new(),
        };
        let first_wire = done(image("root-image"));
        let child_wire = done(image("child-image"));
        tokio::join!(
            forward(child, &child_wire, 10),
            forward(first, &first_wire, 3)
        );
        let mut notifications = vec![receiver.try_recv().unwrap(), receiver.try_recv().unwrap()];
        notifications
            .sort_by_key(|event| event["params"]["item"]["id"].as_str().unwrap().to_owned());
        assert_eq!(notifications[0]["params"]["threadId"], "child");
        assert_eq!(notifications[0]["params"]["turnId"], "child-turn");
        assert_eq!(
            notifications[0]["params"]["item"]["imageRootTurnId"],
            "turn-2"
        );
        assert_eq!(
            notifications[0]["params"]["item"]["imageSourceTurnId"],
            "child-turn"
        );
        assert_eq!(notifications[1]["params"]["turnId"], "turn-1");
        drop(sender);
    }

    #[tokio::test]
    async fn cancelled_registration_cannot_deliver_to_a_replacement_execution() {
        let root = tempfile::tempdir().unwrap();
        let (delivery, sender, mut receiver) = fixture(root.path());
        let token = uuid::Uuid::new_v4().to_string();
        let old = DeliveryRegistration {
            token: token.clone(),
            target: delivery.target.clone(),
        };
        targets()
            .lock()
            .unwrap()
            .insert(token.clone(), old.target.clone());
        let replacement = register(
            &token,
            "unused",
            root.path().to_str().unwrap(),
            "new-root",
            &sender,
        );
        drop(old);
        assert!(Arc::ptr_eq(
            targets().lock().unwrap().get(&token).unwrap(),
            &replacement.target
        ));
        forward(delivery, &done(image("ig")), 7).await;
        assert!(receiver.try_recv().is_err());
        assert!(!root.path().join("private/index.json").exists());
        drop(replacement);
        // Neither a registry entry nor a captured HTTP stream holds the mapper open.
        drop(sender);
        assert!(receiver.recv().await.is_none());
    }

    #[test]
    fn request_identity_uses_explicit_metadata_never_the_latest_turn() {
        let request =
            json!({"client_metadata":{"thread_id":"root","turn_id":"turn","root_turn_id":"turn"}});
        assert_eq!(
            request_owner(&serde_json::to_vec(&request).unwrap())
                .unwrap()
                .turn_id,
            "turn"
        );
        let nested = json!({"client_metadata":{"x-codex-turn-metadata": request["client_metadata"].to_string()}});
        assert_eq!(
            request_owner(&serde_json::to_vec(&nested).unwrap())
                .unwrap()
                .thread_id,
            "root"
        );
        assert!(request_owner(br#"{"client_metadata":{"thread_id":"root"}}"#).is_none());
    }

    #[tokio::test]
    async fn missing_identity_fails_explicitly_instead_of_silently_losing_an_image() {
        let root = tempfile::tempdir().unwrap();
        let (mut delivery, _sender, mut receiver) = fixture(root.path());
        delivery.owner = None;
        let output = forward(delivery, &completed(vec![image("ig")]), 5).await;
        assert!(output.contains("response.failed"));
        assert!(output.contains("ownership"));
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn hosted_images_cross_the_real_http_proxy_including_mislabeled_terminal_only_sse() {
        use super::super::{
            bind_thread, handle_for_token, register as register_upstream, unregister,
            LocalModelProxyUpstream,
        };
        use axum::{
            http::{header, HeaderMap},
            routing::post,
            Router,
        };
        for mislabeled in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (delivery, _sender, mut receiver) = fixture(root.path());
            let item = image("ig-http");
            let wire = if mislabeled {
                completed(vec![item])
            } else {
                format!("{}{}", done(item.clone()), completed(vec![item]))
            };
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let upstream = tokio::spawn(async move {
                axum::serve(
                    listener,
                    Router::new().route(
                        "/responses",
                        post(move || {
                            let wire = wire.clone();
                            async move {
                                (
                                    [(
                                        header::CONTENT_TYPE,
                                        if mislabeled {
                                            "application/json"
                                        } else {
                                            "text/event-stream"
                                        },
                                    )],
                                    wire,
                                )
                            }
                        }),
                    ),
                )
                .await
                .unwrap();
            });
            let token = register_upstream(
                &uuid::Uuid::new_v4().to_string(),
                LocalModelProxyUpstream {
                    base_url: format!("http://{address}"),
                    request_url: None,
                    api_format: "openai-responses".into(),
                    convert_custom_tools: false,
                    native_tool_search: false,
                    native_namespace_tools: false,
                    api_key: String::new(),
                    default_headers: Vec::new(),
                    proxy_url: None,
                    model_id: None,
                    routing_model_id: None,
                    max_output_tokens: None,
                },
            );
            bind_thread(&token, "root").unwrap();
            targets()
                .lock()
                .unwrap()
                .insert(token.clone(), delivery.target.clone());
            let registration = DeliveryRegistration {
                token: token.clone(),
                target: delivery.target,
            };
            let body = json!({
                "model":"synthetic","input":[],"stream":true,
                "client_metadata":{"thread_id":"root","turn_id":"turn-1","root_turn_id":"turn-1"}
            });
            let response = handle_for_token(
                token.clone(),
                HeaderMap::new(),
                Bytes::from(body.to_string()),
            )
            .await
            .unwrap();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let wire = String::from_utf8(body.to_vec()).unwrap();
            assert!(wire.contains("response.completed"));
            assert!(
                wire.contains(&png_base64()),
                "Codex still receives the unmodified image result"
            );
            let notification = receiver.try_recv().unwrap();
            assert_eq!(notification["params"]["turnId"], "turn-1");
            assert!(notification["params"]["item"]["savedPath"].is_string());
            assert!(receiver.try_recv().is_err());
            drop(registration);
            unregister(&token);
            upstream.abort();
        }
    }
}
