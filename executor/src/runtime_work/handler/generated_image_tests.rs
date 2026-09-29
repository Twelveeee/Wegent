// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn image_delivery_before_turn_start_reply_uses_its_verified_turn_and_keeps_failure_status() {
    let root = tempfile::tempdir().unwrap();
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-work.json"));
    let task_id = uuid::Uuid::new_v4().to_string();
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        task_id.clone(),
        root.path().display().to_string(),
        "Image test".into(),
    ));
    let execution_id = start_test_execution(&handler, &task_id);
    let request = ExecutionRequest {
        task_id: task_id.clone(),
        subtask_id: "provisional-subtask".into(),
        ..ExecutionRequest::default()
    };
    let notification = json!({"method":"item/completed","params":{
        "threadId":"root","turnId":"actual-turn",
        "item":{
            "id":"ig","type":"imageGeneration","status":"failed",
            "deliveryError":"Failed to persist image delivery: disk full",
            "imageSourceThreadId":"root","imageSourceTurnId":"actual-turn",
            "imageRootThreadId":"root","imageRootTurnId":"actual-turn"
        }
    }});
    let mut mapper = CodexNotificationEventMapper::default();
    handler
        .map_execution_codex_notification(
            &task_id,
            execution_id,
            &request,
            None,
            &mut mapper,
            notification.clone(),
        )
        .await;
    let event = event_rx.try_recv().unwrap();
    assert_eq!(event["event"], "response.block.updated");
    assert_eq!(event["payload"]["subtaskId"], "actual-turn");
    assert_eq!(event["payload"]["data"]["block"]["status"], "error");
    assert!(
        event["payload"]["data"]["block"]["parent_tool_use_id"].is_null(),
        "A root delivery error must not be hidden under a synthetic subagent"
    );
    assert_eq!(event["payload"]["data"]["updates"]["status"], "error");
    assert_eq!(
        event["payload"]["data"]["updates"]["render_payload"]["deliveryStatus"],
        "failed"
    );
    assert!(event_rx.try_recv().is_err());

    let mut child_image = notification.clone();
    child_image["params"]["threadId"] = json!("child");
    child_image["params"]["turnId"] = json!("child-turn");
    child_image["params"]["item"]["threadId"] = json!("child");
    child_image["params"]["item"]["imageSourceThreadId"] = json!("child");
    child_image["params"]["item"]["imageSourceTurnId"] = json!("child-turn");
    handler.begin_active_codex_transcript(&task_id, "root", "actual-turn");
    handler
        .map_execution_codex_notification(
            &task_id,
            execution_id,
            &request,
            Some(ActiveCodexTurn {
                execution_id,
                thread_id: "root".into(),
                turn_id: "actual-turn".into(),
            }),
            &mut mapper,
            child_image,
        )
        .await;
    let child_event = event_rx.try_recv().unwrap();
    assert_eq!(child_event["payload"]["subtaskId"], "actual-turn");
    assert!(
        child_event["payload"]["data"]["block"]["parent_tool_use_id"].is_string(),
        "Child images must retain native subagent presentation"
    );
    assert!(
        handler
            .active_codex_transcript_messages(&task_id)
            .is_empty(),
        "A child image must not become a parent final-answer image"
    );

    handler
        .map_execution_codex_notification(
            &task_id,
            execution_id,
            &request,
            Some(ActiveCodexTurn {
                execution_id,
                thread_id: "root".into(),
                turn_id: "new-turn".into(),
            }),
            &mut mapper,
            notification,
        )
        .await;
    assert!(
        event_rx.try_recv().is_err(),
        "A late image must not be rebound to a newer turn"
    );
}
