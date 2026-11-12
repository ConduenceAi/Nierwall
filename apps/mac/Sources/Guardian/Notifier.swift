import Foundation
import UserNotifications

/// Local notifications posted by the app itself: no push service ever sees alert content.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    var onOpen: ((String?) -> Void)?
    var onSnooze: ((String) -> Void)?
    private var authorized = false

    override init() {
        super.init()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let review = UNNotificationAction(identifier: "REVIEW", title: "Review", options: [.foreground])
        let snooze = UNNotificationAction(identifier: "SNOOZE", title: "Snooze 1h", options: [])
        center.setNotificationCategories([UNNotificationCategory(identifier: "GUARDIAN_ALERT", actions: [review, snooze], intentIdentifiers: [])])
    }

    func post(title: String, body: String, alertId: String, incidentId: String, critical: Bool) {
        let center = UNUserNotificationCenter.current()
        let send = {
            let c = UNMutableNotificationContent()
            c.title = title
            c.body = body
            c.sound = critical ? .defaultCritical : .default
            c.categoryIdentifier = "GUARDIAN_ALERT"
            c.userInfo = ["alertId": alertId, "incidentId": incidentId]
            center.add(UNNotificationRequest(identifier: alertId, content: c, trigger: nil))
        }
        if authorized { send(); return }
        center.requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] ok, _ in
            self?.authorized = ok
            if ok { send() }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let alertId = info["alertId"] as? String
        let incidentId = info["incidentId"] as? String
        await MainActor.run {
            if response.actionIdentifier == "SNOOZE", let incidentId { onSnooze?(incidentId) } else { onOpen?(alertId) }
        }
    }
}
