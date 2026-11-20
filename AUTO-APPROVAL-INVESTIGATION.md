# 自动审批内部接口检查

检查日期：2026-11-20。对象：本机 Antigravity Desktop 2.33.0、Anti-Claude 3.0.4。

本文件保留初步只读检查的证据和当时的验证边界。后续独立模块的使用与实现说明见 [AUTO-APPROVAL.md](AUTO-APPROVAL.md)。

## 结论与验证边界

客户端存在按对话 ID、轨迹 ID、步骤索引提交权限决定的内部接口，代码路径支持处理非当前对话，无需寻找侧栏链接或先导航到目标对话。Anti-Claude 现有 React Context 服务发现方式能够取得该接口。

本次仅检查客户端脚本与运行中的服务对象、状态结构。未调用审批、注册交互、修改权限或切换对话。运行时检查没有待处理步骤，因此尚未验证真实请求提交、服务端接受及后台任务恢复。

## 接口证据

本机客户端加载的 `/main.js` 中，`AgentServiceContext` 提供：

```js
handleCascadeUserInteraction(cascadeId, interaction)
```

其实现将参数包装为 `{ cascadeId, interaction }` 的 protobuf 请求，再调用底层同名方法。原生权限表单的提交路径为：

1. 取得 `cascadeId`、`trajectoryId`、`stepIndex`。
2. 构造 `CascadeUserInteractionSchema`，其中 `interaction.case` 为 `permission`。
3. 构造 `PermissionInteractionSchema`，包含 `allow` 和 `scope` 等字段。
4. 调用上述服务方法。

概念数据结构如下，实际实现应按当前客户端 protobuf 消息约定构造，不能把此片段视为已验证的直接调用代码：

```js
{
  trajectoryId,
  stepIndex,
  interaction: {
    case: 'permission',
    value: {
      allow: true,
      scope: 1 // 当前版本 PermissionScope.ONCE
    }
  }
}
```

`ONCE` 对应仅本次允许；原生永久授权分支另有 `persistGrants`。自动审批不应写入永久授权或修改资源目标。

## 后台路径证据

原生子代理面板的 Approve 处理器使用该子对话的 ID 调用 `handleCascadeUserInteraction`；处理器没有调用导航逻辑。查看子对话的导航处理器与批准处理器相互独立。

客户端的内部辅助函数（本次脚本中的压缩名称为 `r5`，名称不可视为稳定接口）从等待步骤读取：

- `step.metadata.sourceTrajectoryStepInfo.trajectoryId`
- `step.metadata.sourceTrajectoryStepInfo.stepIndex`
- `step.requestedInteraction.interaction.case`

仅在交互类型为 `permission` 时生成带 `PermissionScope.ONCE` 的批准或拒绝消息。这说明原生客户端已经具有无需显示完整审批表单的单次权限决定路径。

## Anti-Claude 接入点

- `user/custom.js` 的 `resolveCascadeRpcService()` 从 React Context 发现原生服务。运行时已确认这个服务对象具有 `handleCascadeUserInteraction`，同时满足现有解析器的 `searchFiles` 等判定条件。
- `findSidebarBindings()` 已能取得全局状态 store；`trajectorySummaries.summaries` 中各对话的 `waitingSteps` 可供发现候选请求。实际步骤包装层需按原生 `waitingSteps[].step` 结构核对，不应仅从摘要顶层工具名猜测审批种类。
- 对子对话应保留真正拥有待审批请求的对话 ID 和源轨迹信息，不能为了侧栏定位而一律替换成顶层父对话 ID。
- 当前客户端权限表单覆盖命令、文件、MCP、URL 等多种资源动作；模块必须明确区分允许处理的动作。不能将所有等待步骤（例如询问用户的问题）当作权限审批。

## 建议的后续验证

1. 对一个真实、无副作用的命令审批先只读检查等待步骤、权限类型、源轨迹与步骤索引。
2. 构造仅本次允许的消息，提交前重读状态，确认请求仍在等待且目标未变。
3. 验证后台对话可直接恢复运行，当前对话不变；分别覆盖命令、MCP、文件权限及子对话。
4. 验证用户手动处理、请求取消、重复通知、断线和热注入重启时不会重复批准。
5. 通过后再接入模块开关、倒计时、范围配置和状态提示，并确保仅有一个自动审批执行器工作。

## 维护限制

这属于未公开的客户端内部接口，已证实当前版本存在，但后续版本可能改变。应按能力检测接口和请求结构，缺少可靠标识或结构不符时停止自动处理，不能回退成盲目点击。此次没有实现或启用自动审批模块。
