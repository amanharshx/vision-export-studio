import type { OptionsPanelProps } from "./options/_base";
import { GenericOptions } from "./options/generic";
import { CoreMlOptions } from "./options/coreml";
import { MnnOptions } from "./options/mnn";
import { NcnnOptions } from "./options/ncnn";
import { TfLiteOptions } from "./options/tflite";
import { TfJsOptions } from "./options/tfjs";
import { OnnxOptions } from "./options/onnx";
import { OpenVinoOptions } from "./options/openvino";
import { AxeleraOptions } from "./options/axelera";
import { ExecuTorchOptions } from "./options/executorch";
import { ImxOptions } from "./options/imx";
import { PaddleOptions } from "./options/paddle";
import { RfDetrOptions } from "./options/rfdetr";
import { RknnOptions } from "./options/rknn";
import { TensorRtOptions } from "./options/tensorrt";
import { TorchScriptOptions } from "./options/torchscript";
import { SavedModelOptions } from "./options/saved-model";
import { GraphDefOptions } from "./options/graphdef";

const panelMap: Record<string, React.ComponentType<OptionsPanelProps>> = {
  onnx: OnnxOptions,
  torchscript: TorchScriptOptions,
  executorch: ExecuTorchOptions,
  openvino: OpenVinoOptions,
  coreml: CoreMlOptions,
  ncnn: NcnnOptions,
  mnn: MnnOptions,
  tflite: TfLiteOptions,
  edgetpu: ExecuTorchOptions,
  tfjs: TfJsOptions,
  engine: TensorRtOptions,
  rknn: RknnOptions,
  paddle: PaddleOptions,
  imx: ImxOptions,
  axelera: AxeleraOptions,
  saved_model: SavedModelOptions,
  pb: GraphDefOptions,
};

export function OptionsPanel(props: OptionsPanelProps) {
  if (props.route.providerId === "rfdetr") {
    return <RfDetrOptions {...props} />;
  }
  const Panel = panelMap[props.route.targetFormat] ?? GenericOptions;
  return <Panel {...props} />;
}
