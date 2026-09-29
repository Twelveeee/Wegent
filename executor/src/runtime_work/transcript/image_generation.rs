// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Map, Value};

use super::{item_type, string_field};
use crate::attachments::generated_images::materialize_generated_image;

pub(super) struct ImageGenerationRenderContext<'a> {
    pub(super) device_id: &'a str,
    pub(super) workspace_path: &'a str,
}

pub(super) fn insert_image_generation_render_payload(
    object: &mut Map<String, Value>,
    item: &Value,
    context: ImageGenerationRenderContext<'_>,
) {
    if item_type(item) != "imagegeneration" {
        return;
    }
    let mut payload = Map::from_iter([("kind".to_owned(), json!("image_generation"))]);
    if let Some(prompt) =
        string_field(item, "revisedPrompt").or_else(|| string_field(item, "revised_prompt"))
    {
        payload.insert("revisedPrompt".to_owned(), json!(prompt));
    }
    let saved_path = string_field(item, "savedPath").or_else(|| string_field(item, "saved_path"));
    let result = if let Some(error) = string_field(item, "deliveryError") {
        Err(error)
    } else if let Some(path) = saved_path {
        materialize_generated_image(&path, context.workspace_path)
    } else if matches!(
        string_field(item, "status").as_deref(),
        Some("completed" | "failed")
    ) {
        Err("Generated image was not delivered: no saved file is available".into())
    } else {
        object.insert("render_payload".to_owned(), Value::Object(payload));
        return;
    };
    match result {
        Ok(artifact) => {
            payload.extend(Map::from_iter([
                ("deliveryStatus".into(), json!("completed")),
                ("mimeType".into(), json!(artifact.mime_type)),
                ("size".into(), json!(artifact.size)),
                ("width".into(), json!(artifact.width)),
                ("height".into(), json!(artifact.height)),
                (
                    "source".into(),
                    json!({
                        "type": "workspace_file",
                        "deviceId": context.device_id,
                        "workspacePath": artifact.workspace_path,
                        "path": artifact.relative_path,
                    }),
                ),
            ]));
        }
        Err(error) => {
            payload.insert("deliveryStatus".into(), json!("failed"));
            payload.insert("error".into(), json!(error));
            object.insert("status".into(), json!("error"));
        }
    }
    object.insert("render_payload".to_owned(), Value::Object(payload));
}
