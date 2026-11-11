/** Questions concern collaboration and invariants, independent of syntax and named patterns. */
export const designParadigms = [
  { id: 'procedural', form: '过程与模块', questions: '步骤顺序、参数与共享数据的写入权、模块边界和错误返回；不要为了类或接口数量改写直接过程。' },
  { id: 'object', form: '对象协作', questions: '职责、封装、替换契约、组合与继承、对象生命周期；类名或模式名称不是证据。' },
  { id: 'functional', form: '函数与不可变转换', questions: '输入输出、不变量、纯计算与效应边界、组合顺序和累计复制；函数组合本身不说明纯度。' },
  { id: 'dataflow', form: '数据与流水线', questions: 'Schema、阶段契约、依赖、批次/顺序、重复与遗漏、容量和失败提交边界；表和查询也是设计单元。' },
  { id: 'event', form: '事件与消息协作', questions: '消息所有者、投递和顺序、重入、幂等、订阅释放、观察失败和执行结果是否混淆；不假定某种投递保证。' },
  { id: 'concurrent', form: '并发与分布式协作', questions: '检查与提交的原子范围、锁/事务/消息边界、取消、部分成功和未知结果；不能把一个语言的 await 或锁语义推广到另一语言。' },
] as const
