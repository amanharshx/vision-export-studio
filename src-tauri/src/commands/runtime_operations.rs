use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeOperation {
    Export,
    Install,
    Setup,
}

impl RuntimeOperation {
    fn name(self) -> &'static str {
        match self {
            Self::Export => "export",
            Self::Install => "dependency install",
            Self::Setup => "setup",
        }
    }
}

#[derive(Default)]
struct CoordinatorState {
    shared: Vec<RuntimeOperation>,
    rebuild_active: bool,
}

#[derive(Default, Clone)]
pub struct RuntimeOperationCoordinator {
    state: Arc<Mutex<CoordinatorState>>,
}

pub struct RuntimeOperationGuard {
    state: Arc<Mutex<CoordinatorState>>,
    operation: Option<RuntimeOperation>,
}

impl RuntimeOperationCoordinator {
    pub fn acquire_shared(
        &self,
        operation: RuntimeOperation,
    ) -> Result<RuntimeOperationGuard, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "runtime operation coordinator lock poisoned".to_string())?;
        if state.rebuild_active {
            return Err(
                "another runtime operation is in progress: managed runtime rebuild".to_string(),
            );
        }
        state.shared.push(operation);
        Ok(RuntimeOperationGuard {
            state: Arc::clone(&self.state),
            operation: Some(operation),
        })
    }

    pub fn acquire_rebuild(&self) -> Result<RuntimeOperationGuard, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "runtime operation coordinator lock poisoned".to_string())?;
        if let Some(operation) = state.shared.first() {
            return Err(format!(
                "cannot rebuild managed runtime while {} is active",
                operation.name()
            ));
        }
        if state.rebuild_active {
            return Err(
                "another runtime operation is in progress: managed runtime rebuild".to_string(),
            );
        }
        state.rebuild_active = true;
        Ok(RuntimeOperationGuard {
            state: Arc::clone(&self.state),
            operation: None,
        })
    }
}

impl Drop for RuntimeOperationGuard {
    fn drop(&mut self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        match self.operation.take() {
            Some(operation) => {
                if let Some(index) = state.shared.iter().position(|item| *item == operation) {
                    state.shared.remove(index);
                }
            }
            None => state.rebuild_active = false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebuild_is_refused_while_shared_operation_is_active() {
        let coordinator = RuntimeOperationCoordinator::default();
        let _export = coordinator
            .acquire_shared(RuntimeOperation::Export)
            .unwrap();

        assert!(coordinator
            .acquire_rebuild()
            .err()
            .unwrap()
            .contains("export"));
    }

    #[test]
    fn shared_operations_are_refused_while_rebuild_is_active() {
        let coordinator = RuntimeOperationCoordinator::default();
        let _rebuild = coordinator.acquire_rebuild().unwrap();

        for operation in [
            RuntimeOperation::Export,
            RuntimeOperation::Install,
            RuntimeOperation::Setup,
        ] {
            assert!(coordinator.acquire_shared(operation).is_err());
        }
    }

    #[test]
    fn shared_operations_can_run_together() {
        let coordinator = RuntimeOperationCoordinator::default();
        let _export = coordinator
            .acquire_shared(RuntimeOperation::Export)
            .unwrap();
        let _install = coordinator
            .acquire_shared(RuntimeOperation::Install)
            .unwrap();
    }

    #[test]
    fn dropping_shared_guard_allows_rebuild() {
        let coordinator = RuntimeOperationCoordinator::default();
        let operation = coordinator.acquire_shared(RuntimeOperation::Setup).unwrap();
        drop(operation);

        assert!(coordinator.acquire_rebuild().is_ok());
    }

    #[test]
    fn dropping_guard_after_failure_path_unblocks_future_operations() {
        let coordinator = RuntimeOperationCoordinator::default();
        let result: Result<(), ()> = {
            let _operation = coordinator
                .acquire_shared(RuntimeOperation::Install)
                .unwrap();
            Err(())
        };
        assert!(result.is_err());

        assert!(coordinator.acquire_rebuild().is_ok());
    }
}
