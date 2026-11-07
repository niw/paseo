import ExpoModulesCore
import UIKit

private let changeEventName = "onChange"

/// Reports the window regions that system elements occlude, such as the camera and status strip
/// on iPhone Duo, and the status bar frame. The safe-area insets only say how far each edge is
/// covered; these say which part of that band is actually covered.
public class PaseoReservedRegionsModule: Module {
  private var observerView: ReservedRegionsObserverView?

  public func definition() -> ModuleDefinition {
    Name("PaseoReservedRegions")

    Events(changeEventName)

    AsyncFunction("getSnapshot") { () -> [String: Any] in
      return self.snapshot(of: self.observerView ?? self.keyWindow())
    }.runOnQueue(.main)

    OnStartObserving {
      DispatchQueue.main.async { self.installObserver() }
    }

    OnStopObserving {
      DispatchQueue.main.async { self.removeObserver() }
    }

    OnDestroy {
      DispatchQueue.main.async { self.removeObserver() }
    }
  }

  private func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
  }

  private func installObserver() {
    guard observerView == nil, let window = keyWindow() else { return }
    let view = ReservedRegionsObserverView(frame: window.bounds)
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.isUserInteractionEnabled = false
    view.backgroundColor = .clear
    view.onChange = { [weak self] in
      guard let self, let view = self.observerView else { return }
      self.sendEvent(changeEventName, self.snapshot(of: view))
    }
    window.addSubview(view)
    observerView = view
  }

  private func removeObserver() {
    observerView?.removeFromSuperview()
    observerView = nil
  }

  private func snapshot(of view: UIView?) -> [String: Any] {
    guard let view else { return ["occlusions": [], "statusBar": NSNull()] }
    var occlusions: [[String: Double]] = []
    if #available(iOS 27.1, *) {
      for region in view.reservedRegions(kind: .occlusion) where region.isActive {
        occlusions.append(rectPayload(view.convert(region.frame, to: view.window)))
      }
    }
    let statusBar = view.window?.windowScene?.statusBarManager?.statusBarFrame
    return [
      "occlusions": occlusions,
      "statusBar": statusBar.map(rectPayload) ?? NSNull(),
    ]
  }
}

private func rectPayload(_ rect: CGRect) -> [String: Double] {
  [
    "x": Double(rect.origin.x),
    "y": Double(rect.origin.y),
    "width": Double(rect.size.width),
    "height": Double(rect.size.height),
  ]
}

/// A window-sized view that notices when the window's geometry changes, which is when its
/// reserved regions can change: rotation, folding, and resizing.
private final class ReservedRegionsObserverView: UIView {
  var onChange: (() -> Void)?

  override func layoutSubviews() {
    super.layoutSubviews()
    onChange?()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    onChange?()
  }
}
