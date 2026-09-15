/**
 * 前端入口：装配全部视图并启动。
 * 视图注册表在这里集中声明 —— 新增视图只需在此处加一行。
 */
import { installGlobalDropzone, startApp } from './app.ts';
import { sampleTrace } from './sample.ts';
import overview from './views/overview.ts';
import timeline from './views/timeline.ts';
import pipeline from './views/pipeline.ts';
import fsm from './views/fsm.ts';
import counters from './views/counters.ts';
import values from './views/values.ts';
import table from './views/table.ts';

installGlobalDropzone();

startApp([overview, timeline, pipeline, fsm, counters, values, table], {
  name: 'sample.chiperf',
  text: sampleTrace(),
});
